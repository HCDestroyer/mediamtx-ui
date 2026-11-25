package service

import (
	"regexp"

	"nodo/agent/internal/media"
)

var secretOption = regexp.MustCompile(`(?i)((?:passphrase|pass|password|key|token)=)[^&#]*`)

// redactURL hides credentials and secret options of an address before it is shown or logged.
func redactURL(url string) string {
	return secretOption.ReplaceAllString(media.Redact(url), "${1}***")
}
