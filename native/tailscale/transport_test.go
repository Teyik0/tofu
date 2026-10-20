package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
