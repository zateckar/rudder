package ingress

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCapturePreservesApplicationRequest(t *testing.T) {
	const host = "app.example.test"
	const key = "isolated-test-secret-0123456789abcdef"
	stamp := "rudder-11111111-1111-4111-8111-111111111111." + strings.Repeat("a", 64)
	t.Setenv("RUDDER_LEARNING_INGRESS_KEY", key)
	captures := 0
	helper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captures++
		if r.Host != host || r.Header.Get("X-Rudder-Ingress-Key") != key ||
			r.Header.Get("X-Rudder-Learning-Cookie") != "valid" {
			t.Error("unexpected helper request")
		}
		w.Header().Set(transaction, stamp)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer helper.Close()

	var observed string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = r.Header.Get(transaction)
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/original" || string(body) != "payload" ||
			r.Header.Get("Cookie") != "app=login" || r.Header.Get("X-Rudder-Ingress-Key") != "" {
			t.Error("application request changed")
		}
		w.WriteHeader(http.StatusAccepted)
	})
	middleware, err := New(context.Background(), next, &Config{
		OriginHost: host, Endpoint: helper.URL + "/_capture",
	}, "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ cookie, stamp string }{
		{"app=login", ""},
		{"app=login; __Host-rudder-learning=valid", stamp},
		{"app=login; __Host-rudder-learning=valid; __Host-rudder-learning=valid", ""},
	} {
		r := httptest.NewRequest(http.MethodPost, "https://"+host+"/original", strings.NewReader("payload"))
		r.Header.Set("Cookie", c.cookie)
		r.Header.Set(transaction, "client-supplied")
		r.Header.Set("X-Rudder-Ingress-Key", "client-supplied")
		response := httptest.NewRecorder()
		middleware.ServeHTTP(response, r)
		if observed != c.stamp || response.Code != http.StatusAccepted {
			t.Fatal("capture stamp or upstream status did not match")
		}
	}
	if captures != 1 {
		t.Fatalf("got %d capture calls, want one", captures)
	}
	helper.Close()
	r := httptest.NewRequest(http.MethodPost, "https://"+host+"/original", strings.NewReader("payload"))
	r.Header.Set("Cookie", "app=login; __Host-rudder-learning=valid")
	response := httptest.NewRecorder()
	middleware.ServeHTTP(response, r)
	if observed != "" || response.Code != http.StatusAccepted {
		t.Fatal("capture outage interrupted normal request handling")
	}
}
