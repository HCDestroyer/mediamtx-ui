package host

// Finding is one observation with a stable id; the panel owns the wording (why it matters and what to do),
// so the agent only says what it saw and with which numbers.
type Finding struct {
	ID     string         `json:"id"`
	Level  string         `json:"level"` // ok, info, warn
	Params map[string]any `json:"params,omitempty"`
}

const (
	minRmem        = 8 << 20 // 8 MiB: enough for several HD multicast streams
	lowMemoryRatio = 0.10
)

func has(list []string, names ...string) bool {
	for _, l := range list {
		for _, n := range names {
			if l == n {
				return true
			}
		}
	}
	return false
}

// Advise turns a view into recommendations. It is a pure function so every rule is testable.
func Advise(v View, tools []ToolPresence, encoders []string) []Finding {
	found := map[string]bool{}
	for _, t := range tools {
		found[t.ID] = t.Found
	}
	var out []Finding
	add := func(id, level string, params map[string]any) {
		out = append(out, Finding{ID: id, Level: level, Params: params})
	}

	if !found["ffmpeg"] {
		add("ffmpeg-missing", "warn", nil)
	}
	if v.Memory.TotalKB > 0 && float64(v.Memory.AvailableKB)/float64(v.Memory.TotalKB) < lowMemoryRatio {
		add("mem-low", "warn", map[string]any{"availableMB": v.Memory.AvailableKB / 1024, "totalMB": v.Memory.TotalKB / 1024})
	}

	// Network.
	physicalUp := 0
	for _, r := range v.Rates {
		if r.Virtual || !r.Up {
			continue
		}
		physicalUp++
		if r.RecentErrors > 0 {
			add("net-errors", "warn", map[string]any{"interface": r.Name, "count": r.RecentErrors})
		}
		if r.SpeedMbps > 0 && r.SpeedMbps < 1000 {
			add("nic-slow", "info", map[string]any{"interface": r.Name, "speedMbps": r.SpeedMbps})
		}
	}
	switch {
	case v.RecentUDPDrops > 0:
		add("net-rmem-low", "warn", map[string]any{"drops": v.RecentUDPDrops, "rmemMax": v.Tuning.RmemMax})
	case v.Tuning.RmemMax > 0 && v.Tuning.RmemMax < minRmem:
		add("net-rmem-low", "info", map[string]any{"rmemMax": v.Tuning.RmemMax})
	}
	if v.Tuning.RpFilter == 1 && physicalUp >= 2 {
		add("net-rpfilter", "info", map[string]any{"interfaces": physicalUp})
	}
	if v.Tuning.Governor != "" && v.Tuning.Governor != "performance" {
		add("cpu-governor", "info", map[string]any{"governor": v.Tuning.Governor})
	}

	// GPUs and hardware encoding.
	if len(v.GPUs) == 0 {
		add("gpu-none", "info", nil)
	}
	for _, g := range v.GPUs {
		var want []string
		switch g.Vendor {
		case "nvidia":
			want = []string{"h264_nvenc"}
		case "intel":
			want = []string{"h264_qsv", "h264_vaapi"}
		case "amd":
			want = []string{"h264_vaapi", "h264_amf"}
		default:
			continue
		}
		if has(encoders, want...) {
			add("gpu-ready", "ok", map[string]any{"vendor": g.Vendor, "encoder": firstOf(encoders, want)})
		} else {
			add("gpu-encoder-missing", "warn", map[string]any{"vendor": g.Vendor, "needs": want[0]})
		}
	}

	// DVB.
	for _, c := range v.PCICards {
		if c.Driver == "" && len(v.DVB) == 0 {
			add("dvb-driver-missing", "warn", map[string]any{"vendor": c.Vendor, "device": c.Device})
		}
	}
	if len(v.DVB) > 0 {
		if found["tsduck"] || found["dvblast"] {
			add("dvb-ready", "ok", map[string]any{"adapters": len(v.DVB)})
		} else {
			add("dvb-tools-missing", "warn", map[string]any{"adapters": len(v.DVB)})
		}
	}
	return out
}

func firstOf(have, want []string) string {
	for _, w := range want {
		if has(have, w) {
			return w
		}
	}
	return ""
}
