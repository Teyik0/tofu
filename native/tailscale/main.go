// Tofu's native network companion: the private tsnet host and the local network HTTPS ingress.
// Control is available only over inherited process pipes.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
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
	// Loopback port of the Tofu application listener; the only forwarding target.
	Port int `json:"port"`
	// Public local network HTTPS port and the names or addresses it answers for.
	LANPort int      `json:"lanPort"`
	Hosts   []string `json:"hosts"`
}

type result struct {
	ApprovalURL  string   `json:"approvalUrl,omitempty"`
	ID           string   `json:"id"`
	State        string   `json:"state"`
	Origin       string   `json:"origin,omitempty"`
	AuthURL      string   `json:"authUrl,omitempty"`
	Error        string   `json:"error,omitempty"`
	HTTPSEnabled bool     `json:"httpsEnabled"`
	Hosts        []string `json:"hosts,omitempty"`
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

// The browser-facing host of a local network name or address: lowercase names, canonical IP
// text and no port for HTTPS's default port, as browsers send it in Host.
func canonicalHost(name, port string) string {
	if ip := net.ParseIP(name); ip != nil {
		name = ip.String()
	} else {
		name = strings.ToLower(name)
	}
	if port != "443" {
		return net.JoinHostPort(name, port)
	}
	if strings.Contains(name, ":") {
		return "[" + name + "]"
	}
	return name
}

// openLAN serves HTTPS on every interface with the installation certificate. Only requests whose
// Host is a name or address covered by that certificate reach the loopback application; loopback
// names stay with the application's own listener. It is independent of any tsnet node.
func openLAN(dir string, port, lanPort int, names []string) (*http.Server, []string, error) {
	if !filepath.IsAbs(dir) {
		return nil, nil, errors.New("The local network certificate directory is unavailable")
	}
	if port < 1 || port > 65535 || lanPort < 1 || lanPort > 65535 || port == lanPort {
		return nil, nil, errors.New("Choose a local network port different from Tofu's own port")
	}
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "server.pem"), filepath.Join(dir, "server-key.pem"))
	if err != nil {
		return nil, nil, errors.New("Create the local network certificate on the server first")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, nil, errors.New("The local network certificate is unreadable. Renew it on the server")
	}
	if now := time.Now(); now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return nil, nil, errors.New("The local network certificate is expired or not yet valid. Renew it on the server")
	}
	public := strconv.Itoa(lanPort)
	routes := map[string]http.Handler{}
	hosts := []string{}
	for _, name := range names {
		ip := net.ParseIP(name)
		if len(routes) >= 32 || strings.EqualFold(name, "localhost") || (ip != nil && ip.IsLoopback()) || leaf.VerifyHostname(name) != nil {
			continue
		}
		host := canonicalHost(name, public)
		if routes[host] == nil {
			routes[host] = inboundProxy(port, "https://"+host)
			hosts = append(hosts, host)
		}
	}
	if len(hosts) == 0 {
		return nil, nil, errors.New("The local network certificate covers none of this server's names or addresses. Renew it on the server")
	}
	// Bind IPv4 and IPv6 separately: a dual-stack socket can succeed while another program holds
	// the IPv4 port, which would silently send IPv4 clients to that program.
	busy := fmt.Errorf("Port %d is already in use on this computer. Choose another local network port", lanPort)
	listeners := []net.Listener{}
	ipv4, err := net.Listen("tcp4", "0.0.0.0:"+public)
	if err != nil {
		return nil, nil, busy
	}
	listeners = append(listeners, ipv4)
	ipv6, err := net.Listen("tcp6", "[::]:"+public)
	if errors.Is(err, syscall.EADDRINUSE) {
		ipv4.Close()
		return nil, nil, busy
	}
	if err == nil {
		listeners = append(listeners, ipv6)
	}
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name, requested, err := net.SplitHostPort(r.Host)
			if err != nil {
				name, requested = strings.TrimSuffix(strings.TrimPrefix(r.Host, "["), "]"), "443"
			}
			route := routes[canonicalHost(name, requested)]
			if route == nil || requested != public {
				http.Error(w, "This is not a Tofu local network address.", http.StatusMisdirectedRequest)
				return
			}
			route.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32768,
		ErrorLog:          log.New(io.Discard, "", 0),
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12},
	}
	for _, listener := range listeners {
		go func() {
			if err := server.ServeTLS(listener, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				listener.Close()
			}
		}()
	}
	return server, hosts, nil
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
	tlsDir := os.Getenv("TOFU_TLS_STATE_DIR")
	var node *tsnet.Server
	var listener net.Listener
	var server *http.Server
	var lan *http.Server
	origin := ""
	servePort := 0
	closeLAN := func() {
		if lan != nil {
			lan.Close()
			lan = nil
		}
	}
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
		closeLAN()
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
					// A restarted application may listen on another port; never keep a stale target.
					if listener != nil && servePort != cmd.Port {
						closeListener()
					}
					if listener == nil {
						listener, err = node.ListenTLS("tcp", ":443")
						if err != nil {
							answer.Error = "Unable to open private HTTPS"
							break
						}
						origin = answer.Origin
						servePort = cmd.Port
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
		case "lan-open":
			// Replacing the listener releases its port first; the caller restores the previous one on failure.
			closeLAN()
			opened, hosts, err := openLAN(tlsDir, cmd.Port, cmd.LANPort, cmd.Hosts)
			if err != nil {
				answer.Error = err.Error()
				break
			}
			lan = opened
			answer.Hosts = hosts
			answer.State = "ready"
		case "lan-close":
			closeLAN()
		case "stop":
			// Stops only the private network; the local network ingress is independent.
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
