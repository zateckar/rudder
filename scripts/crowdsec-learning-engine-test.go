// Copied into the pinned CrowdSec source tree by crowdsec-learning-engine.sh.
package appsecacquisition

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/crowdsecurity/crowdsec/pkg/pipeline"
)

func TestRudderLearningAlert(t *testing.T) {
	const host = "test.example"
	const key = "a-test-key-at-least-32-characters"
	const id = "rudder-11111111-1111-4111-8111-111111111111"
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(id))
	stamp := id + "." + hex.EncodeToString(mac.Sum(nil))
	input := pipeline.Event{
		Parsed: map[string]string{"source_ip": "192.0.2.1"},
		Appsec: pipeline.AppsecEvent{
			MatchedRules: pipeline.MatchedRules{{"name": "crowdsecurity/test", "hash": "fixture", "version": "1"}},
			HookVars:     map[string]string{"test": "preserved"},
		},
	}
	t.Setenv("RUDDER_LEARNING_HOST", host)
	t.Setenv("RUDDER_LEARNING_INGRESS_KEY", key)

	event := func(t *testing.T, requestHost, requestID string) *pipeline.Event {
		t.Helper()
		input.Parsed["req_uuid"] = requestID
		result, err := AppsecEventGeneration(input, httptest.NewRequest("GET", "https://"+requestHost+"/", nil))
		if err != nil {
			t.Fatal(err)
		}
		if result != nil {
			alert := result.Overflow.Alert
			alert.StartAt, alert.StopAt = nil, nil
			for _, item := range alert.Events {
				item.Timestamp = nil
			}
			result.Overflow.APIAlerts[0] = *alert
		}
		return result
	}
	if event(t, host, stamp) != nil {
		t.Fatal("a signed request with no WAF match generated an alert")
	}
	for _, inBand := range []bool{true, false} {
		input.Appsec.HasInBandMatches = inBand
		input.Appsec.HasOutBandMatches = !inBand
		control := event(t, host, "")
		if control == nil || !control.Process || *control.Overflow.Alert.Scenario != "crowdsecurity/test" ||
			len(control.Overflow.Alert.Events) != 1 || control.Appsec.HookVars["test"] != "preserved" {
			t.Fatal("ordinary alert, matched rule or hook context was lost")
		}
		wantMessage := "WAF out-of-band match: "
		if inBand {
			wantMessage = "WAF block: "
		}
		if !strings.HasPrefix(*control.Overflow.Alert.Message, wantMessage) {
			t.Fatal("ordinary WAF outcome changed")
		}
		tagged := event(t, host, stamp)
		alert := tagged.Overflow.Alert
		if len(alert.Meta) != len(control.Overflow.Alert.Meta)+1 ||
			alert.Meta[len(alert.Meta)-1].Key != "rudder_request_id" || alert.Meta[len(alert.Meta)-1].Value != id {
			t.Fatal("the authentic request ID was not appended")
		}
		alert.Meta = control.Overflow.Alert.Meta
		tagged.Overflow.APIAlerts[0] = *alert
		if !reflect.DeepEqual(control, tagged) {
			t.Fatal("tagged request changed the alert beyond appending metadata")
		}
		for _, invalid := range []string{id, id + "." + strings.Repeat("0", 64), "invalid"} {
			if !reflect.DeepEqual(control, event(t, host, invalid)) {
				t.Fatal("untrusted ID altered the alert")
			}
		}
		if !reflect.DeepEqual(event(t, "other.example", ""), event(t, "other.example", stamp)) {
			t.Fatal("a signed marker on another host altered the alert")
		}
	}
	for _, setting := range []string{"RUDDER_LEARNING_HOST", "RUDDER_LEARNING_INGRESS_KEY"} {
		t.Run(setting, func(t *testing.T) {
			t.Setenv(setting, "")
			control := event(t, host, "")
			if !reflect.DeepEqual(control, event(t, host, stamp)) || !reflect.DeepEqual(control, event(t, host, id)) {
				t.Fatal("missing signing configuration allowed an ID through")
			}
		})
	}
}
