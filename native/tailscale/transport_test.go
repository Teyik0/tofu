package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// External boundary proof: real HTTP streams pass through the production forwarding handler.
func TestInboundTransport(t *testing.T) {
	cancelled := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "https://fixture.example.ts.net" || r.Header.Get("Cookie") != "session=opaque" || r.Header.Get("X-Forwarded-Host") != "fixture.example.ts.net" || r.Header.Get("Forwarded") != "" {
			t.Error("origin, cookie or forwarding boundary changed")
		}
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		if r.URL.Path == "/stream" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Write([]byte("data: ready\n\n"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(cancelled)
			return
		}
		http.ServeContent(w, r, "episode.mp4", time.Now(), bytes.NewReader([]byte("0123456789")))
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(target.Port())
	edge := httptest.NewTLSServer(inboundProxy(port, "https://fixture.example.ts.net"))
	defer edge.Close()
	client := edge.Client()
	request, _ := http.NewRequest("GET", edge.URL+"/episode", nil)
	request.Header.Set("Origin", "https://fixture.example.ts.net")
	request.Header.Set("Cookie", "session=opaque")
	request.Header.Set("Range", "bytes=2-5")
	request.Header.Set("Forwarded", "for=attacker")
	request.Header.Set("X-Forwarded-Host", "attacker")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 206 || string(body) != "2345" || response.Header.Get("Cross-Origin-Embedder-Policy") != "require-corp" {
		t.Fatalf("range or isolation changed: %d %q", response.StatusCode, body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream, _ := http.NewRequestWithContext(ctx, "GET", edge.URL+"/stream", nil)
	stream.Header = request.Header.Clone()
	stream.Header.Del("Range")
	response, err = client.Do(stream)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 13)
	if _, err := io.ReadFull(response.Body, chunk); err != nil || !strings.Contains(string(chunk), "ready") {
		t.Fatalf("SSE buffered: %s %v", chunk, err)
	}
	cancel()
	response.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("disconnect did not cancel backend stream")
	}
}

// Local network ingress boundary: certificate-covered hosts only, controlled forwarding headers,
// real TLS from a client that trusts only the installation certificate.
func TestLANIngress(t *testing.T) {
	seen := make(chan http.Header, 8)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		http.ServeContent(w, r, "episode.mp4", time.Now(), bytes.NewReader([]byte("0123456789")))
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	port, _ := strconv.Atoi(target.Port())

	dir := t.TempDir()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"tofu.home.arpa", "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature, IsCA: true, BasicConstraintsValid: true}
	der, _ := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	encoded, _ := x509.MarshalPKCS8PrivateKey(key)
	os.WriteFile(filepath.Join(dir, "server.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
	os.WriteFile(filepath.Join(dir, "server-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0600)

	free, _ := net.Listen("tcp", "127.0.0.1:0")
	lanPort := free.Addr().(*net.TCPAddr).Port
	free.Close()
	if _, _, err := openLAN(dir, port, port, []string{"tofu.home.arpa"}); err == nil {
		t.Fatal("the public port must differ from the application port")
	}
	server, hosts, err := openLAN(dir, port, lanPort, []string{"TOFU.home.arpa", "localhost", "127.0.0.1", "other.home.arpa"})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	public := "tofu.home.arpa:" + strconv.Itoa(lanPort)
	if len(hosts) != 1 || hosts[0] != public {
		t.Fatalf("only certificate-covered, non-loopback hosts are served: %v", hosts)
	}
	if _, _, err := openLAN(dir, port, lanPort, []string{"tofu.home.arpa"}); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("a busy port must be reported: %v", err)
	}

	roots := x509.NewCertPool()
	parsed, _ := x509.ParseCertificate(der)
	roots.AddCert(parsed)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, "127.0.0.1:"+strconv.Itoa(lanPort))
		},
		TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "tofu.home.arpa"},
	}}
	send := func(host string, header http.Header) *http.Response {
		request, _ := http.NewRequest("GET", "https://tofu.home.arpa/episode", nil)
		request.Host = host
		request.Header = header
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := send("TOFU.home.arpa:"+strconv.Itoa(lanPort), http.Header{
		"Range":             {"bytes=2-5"},
		"Forwarded":         {"for=attacker;host=fixture.example.ts.net"},
		"X-Forwarded-Host":  {"fixture.example.ts.net"},
		"X-Forwarded-For":   {"203.0.113.9"},
		"X-Forwarded-Proto": {"http"},
	})
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 206 || string(body) != "2345" || response.Header.Get("Cross-Origin-Opener-Policy") != "same-origin" {
		t.Fatalf("range or isolation changed: %d %q", response.StatusCode, body)
	}
	header := <-seen
	if header.Get("X-Forwarded-Host") != public || header.Get("X-Forwarded-Proto") != "https" || header.Get("X-Forwarded-For") != "127.0.0.1" || header.Get("Forwarded") != "" {
		t.Fatalf("forwarding headers must be reconstructed: %v", header)
	}
	for _, host := range []string{
		"evil.example:" + strconv.Itoa(lanPort),
		"other.home.arpa:" + strconv.Itoa(lanPort),
		"localhost:" + strconv.Itoa(lanPort),
		"127.0.0.1:" + strconv.Itoa(lanPort),
		"tofu.home.arpa:" + strconv.Itoa(lanPort) + "0",
		"tofu.home.arpa:0" + strconv.Itoa(lanPort),
		"tofu.home.arpa:" + strconv.Itoa(lanPort) + ":1",
		"tofu.home.arpa",
	} {
		response := send(host, http.Header{})
		response.Body.Close()
		if response.StatusCode != http.StatusMisdirectedRequest {
			t.Fatalf("host %q reached the application: %d", host, response.StatusCode)
		}
	}
	select {
	case header := <-seen:
		t.Fatalf("a refused host reached the application: %v", header)
	default:
	}
}
