package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Certificate generation does not start tsnet, log in, or install system trust.
func certificates() error {
	dir := os.Getenv("TOFU_TLS_STATE_DIR")
	if !filepath.IsAbs(dir) {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	var input struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	now := time.Now()
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	ca := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Tofu private installation CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	// Existing installation authority is kept; only the server leaf is refreshed.
	if certPEM, err := os.ReadFile(filepath.Join(dir, "ca.pem")); err == nil {
		block, _ := pem.Decode(certPEM)
		if block == nil {
			return os.ErrInvalid
		}
		ca, err = x509.ParseCertificate(block.Bytes)
		if err != nil {
			return err
		}
		keyPEM, err := os.ReadFile(filepath.Join(dir, "ca-key.pem"))
		if err != nil {
			return err
		}
		block, _ = pem.Decode(keyPEM)
		if block == nil {
			return os.ErrInvalid
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return err
		}
		var ok bool
		caKey, ok = parsed.(*ecdsa.PrivateKey)
		if !ok {
			return os.ErrInvalid
		}
	} else {
		cert, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
		if err != nil {
			return err
		}
		encoded, err := x509.MarshalPKCS8PrivateKey(caKey)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "ca-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0600); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "ca.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0600); err != nil {
			return err
		}
		ca, err = x509.ParseCertificate(cert)
		if err != nil {
			return err
		}
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	leaf := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Tofu server"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(0, 3, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, name := range append(input.Names, "localhost", "127.0.0.1", "::1") {
		if ip := net.ParseIP(name); ip != nil {
			leaf.IPAddresses = append(leaf.IPAddresses, ip)
		} else if name != "" && !strings.ContainsAny(name, "/\\ \n") {
			leaf.DNSNames = append(leaf.DNSNames, name)
		}
	}
	cert, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	key, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "server-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "server.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0600); err != nil {
		return err
	}
	digest := sha256.Sum256(ca.Raw)
	return json.NewEncoder(os.Stdout).Encode(struct {
		Fingerprint string `json:"fingerprint"`
		ExpiresAt   int64  `json:"expiresAt"`
	}{hex.EncodeToString(digest[:]), leaf.NotAfter.UnixMilli()})
}
