package ingress

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const cookie = "__Host-rudder-learning"
const transaction = "X-Crowdsec-Appsec-Transaction-Id"

var signedID = regexp.MustCompile(`^rudder-[0-9a-f-]{36}\.[0-9a-f]{64}$`)

type Config struct {
	OriginHost string `json:"originHost"`
	Endpoint   string `json:"endpoint"`
}

func CreateConfig() *Config { return &Config{} }

type middleware struct {
	config Config
	secret string
	next   http.Handler
	client *http.Client
	slots  chan struct{}
}

func New(_ context.Context, next http.Handler, config *Config, _ string) (http.Handler, error) {
	endpoint, err := url.Parse(config.Endpoint)
	secret := os.Getenv("RUDDER_LEARNING_INGRESS_KEY")
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" ||
		endpoint.Port() == "" || endpoint.Path != "/_capture" || endpoint.RawQuery != "" ||
		endpoint.User != nil || config.OriginHost == "" || len(secret) < 32 {
		return nil, fmt.Errorf("invalid Rudder learning configuration")
	}
	return &middleware{
		config: *config,
		secret: secret,
		next:   next,
		client: &http.Client{
			Timeout: 100 * time.Millisecond,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		slots: make(chan struct{}, 16),
	}, nil
}

func (m *middleware) ServeHTTP(writer http.ResponseWriter, req *http.Request) {
	if strings.EqualFold(req.Host, m.config.OriginHost) {
		req.Header.Del(transaction)
		req.Header.Del("X-Rudder-Ingress-Key")
		req.Header.Del("X-Rudder-Learning-Cookie")
		if credential := stripCookie(req.Header); credential != "" {
			if id := m.capture(req.Context(), credential); id != "" {
				req.Header.Set(transaction, id)
			}
		}
	}
	m.next.ServeHTTP(writer, req)
}

func stripCookie(headers http.Header) string {
	var credential string
	count := 0
	var ordinary []string
	for _, line := range headers.Values("Cookie") {
		parts := strings.Split(line, ";")
		var remaining []string
		for _, part := range parts {
			name, value, _ := strings.Cut(part, "=")
			if strings.TrimSpace(name) == cookie {
				count++
				credential = strings.TrimSpace(value)
			} else if strings.TrimSpace(part) != "" {
				remaining = append(remaining, part)
			}
		}
		if len(remaining) != 0 {
			ordinary = append(ordinary, strings.TrimSpace(strings.Join(remaining, ";")))
		}
	}
	if count != 0 {
		headers.Del("Cookie")
		for _, line := range ordinary {
			headers.Add("Cookie", line)
		}
	}
	if count == 1 && len(credential) <= 128 {
		return credential
	}
	return ""
}

func (m *middleware) capture(ctx context.Context, credential string) string {
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	default:
		return ""
	}
	check, err := http.NewRequestWithContext(ctx, http.MethodPost, m.config.Endpoint, nil)
	if err != nil {
		return ""
	}
	check.Host = m.config.OriginHost
	check.Header.Set("X-Rudder-Ingress-Key", m.secret)
	check.Header.Set("X-Rudder-Learning-Cookie", credential)
	result, err := m.client.Do(check)
	if err != nil {
		return ""
	}
	defer result.Body.Close()
	id := result.Header.Get(transaction)
	if result.StatusCode == http.StatusNoContent && signedID.MatchString(id) {
		return id
	}
	return ""
}
