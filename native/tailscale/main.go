// Tofu's private tsnet host. Control is available only over inherited process pipes.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type command struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
}

type result struct {
	ApprovalURL  string `json:"approvalUrl,omitempty"`
	ID           string `json:"id"`
	State        string `json:"state"`
	Origin       string `json:"origin,omitempty"`
	AuthURL      string `json:"authUrl,omitempty"`
	Error        string `json:"error,omitempty"`
	HTTPSEnabled bool   `json:"httpsEnabled"`
}

// Only a fixed loopback backend is reachable. Caller-supplied forwarding headers are discarded.
// TLS remains end-to-end between the remote browser and tsnet's private HTTPS listener.
func inboundProxy(port int, origin string) http.Handler {
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	return &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(target)
			p.Out.Host = target.Host
			p.Out.Header.Del("Forwarded")
			p.Out.Header.Del("X-Forwarded-For")
			p.Out.Header.Del("X-Forwarded-Host")
			p.Out.Header.Del("X-Forwarded-Proto")
			peer, _, _ := net.SplitHostPort(p.In.RemoteAddr)
			p.Out.Header.Set("X-Forwarded-For", peer)
			p.Out.Header.Set("X-Forwarded-Host", strings.TrimPrefix(origin, "https://"))
			p.Out.Header.Set("X-Forwarded-Proto", "https")
		},
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "Tofu is restarting. Try again shortly.", http.StatusServiceUnavailable)
		},
	}
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "certificates" {
		if err := certificates(); err != nil {
			fmt.Fprintln(os.Stderr, "Certificate generation failed")
			os.Exit(1)
		}
		return
	}
	stateDir := os.Getenv("TOFU_TSNET_STATE_DIR")
	if !filepath.IsAbs(stateDir) {
		fmt.Fprintln(os.Stderr, "An absolute private state directory is required")
		os.Exit(1)
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		os.Exit(1)
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var node *tsnet.Server
	var listener net.Listener
	var server *http.Server
	origin := ""
	closeListener := func() {
		if server != nil {
			server.Close()
			server = nil
		}
		if listener != nil {
			listener.Close()
			listener = nil
		}
		origin = ""
	}
	defer func() {
		closeListener()
		if node != nil {
			node.Close()
		}
	}()
	go func() { <-ctx.Done(); os.Stdin.Close() }()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 16384)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var cmd command
		if json.Unmarshal(scanner.Bytes(), &cmd) != nil || len(cmd.ID) > 64 {
			break
		}
		answer := result{ID: cmd.ID, State: "stopped"}
		timeout, done := context.WithTimeout(ctx, 10*time.Second)
		switch cmd.Method {
		case "start":
			if node == nil {
				if cmd.Hostname == "" || len(cmd.Hostname) > 63 || strings.ContainsAny(cmd.Hostname, "/\\. \n") {
					answer.Error = "Choose a valid Tailscale device name"
					break
				}
				node = &tsnet.Server{Dir: stateDir, Hostname: cmd.Hostname, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
				if err := node.Start(); err != nil {
					node.Close()
					node = nil
					answer.Error = "Unable to start the private network"
					break
				}
			}
			fallthrough
		case "status", "serve", "authorize-https":
			if node == nil {
				break
			}
			client, err := node.LocalClient()
			if err != nil {
				answer.Error = "Private network control is unavailable"
				break
			}
			status, err := client.Status(timeout)
			if err != nil {
				answer.Error = "Private network status is unavailable"
				break
			}
			answer.State = status.BackendState
			answer.AuthURL = status.AuthURL
			if status.Self != nil && status.BackendState == "Running" {
				name := strings.TrimSuffix(status.Self.DNSName, ".")
				if name != "" {
					answer.Origin = "https://" + name
				}
				for _, domain := range status.CertDomains {
					if domain == name {
						answer.HTTPSEnabled = true
					}
				}
				if cmd.Method == "authorize-https" && !answer.HTTPSEnabled {
					// Query the private Serve consent flow, never Funnel or a Serve mapping.
					answer.ApprovalURL = "https://console.tailscale.com/admin/dns"
					info, err := client.QueryFeature(timeout, "serve")
					if err == nil && info != nil && info.URL != "" {
						approval, parseErr := url.Parse(info.URL)
						if parseErr == nil && approval.Scheme == "https" && approval.User == nil &&
							(approval.Host == "login.tailscale.com" || approval.Host == "console.tailscale.com") {
							answer.ApprovalURL = approval.String()
						}
					}
				}
				if cmd.Method == "serve" {
					if cmd.Port < 1 || cmd.Port > 65535 || name == "" {
						answer.Error = "The Tofu listener is not ready"
						break
					}
					if !answer.HTTPSEnabled {
						answer.State = "https-disabled"
						break
					}
					if listener == nil {
						listener, err = node.ListenTLS("tcp", ":443")
						if err != nil {
							answer.Error = "Unable to open private HTTPS"
							break
						}
						origin = answer.Origin
						server = &http.Server{Handler: inboundProxy(cmd.Port, origin), ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 32768}
						active := server
						incoming := listener
						go func() {
							if err := active.Serve(incoming); err != nil && !errors.Is(err, http.ErrServerClosed) {
								incoming.Close()
							}
						}()
					}
				}
			}
			if listener != nil {
				answer.State = "ready"
				answer.Origin = origin
			}
		case "stop":
			closeListener()
			if node != nil {
				node.Close()
				node = nil
			}
		case "logout":
			closeListener()
			if node != nil {
				client, err := node.LocalClient()
				if err != nil || client.Logout(timeout) != nil {
					answer.Error = "Unable to sign out of the private network"
				}
				node.Close()
				node = nil
			}
		default:
			answer.Error = "Unknown private network command"
		}
		done()
		if encoder.Encode(answer) != nil {
			break
		}
	}
}
