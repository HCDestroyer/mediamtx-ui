// Package testutil builds real transport streams with FFmpeg for tests.
package testutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// MakeTS asks FFmpeg for a short real stream (H.264 video plus one AAC track per language).
// The first stream gets startPID and the others follow; the test is skipped when FFmpeg is missing.
func MakeTS(t testing.TB, startPID int, langs []string, seconds int) []byte {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25"}
	tones := []string{"440", "880", "1320"}
	for i := range langs {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency="+tones[i%len(tones)])
	}
	args = append(args, "-t", strconv.Itoa(seconds), "-map", "0:v")
	for i := range langs {
		args = append(args, "-map", strconv.Itoa(i+1)+":a")
	}
	args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-c:a", "aac", "-b:a", "32k")
	for i, lang := range langs {
		args = append(args, "-metadata:s:a:"+strconv.Itoa(i), "language="+lang)
	}
	file := filepath.Join(t.TempDir(), "in.ts")
	args = append(args,
		"-mpegts_service_id", "7", "-mpegts_pmt_start_pid", "4000", "-mpegts_start_pid", strconv.Itoa(startPID),
		"-f", "mpegts", file)
	if out, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, out)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
