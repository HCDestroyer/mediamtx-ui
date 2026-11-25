package host

import "testing"

func ids(fs []Finding) map[string]string {
	m := map[string]string{}
	for _, f := range fs {
		m[f.ID] = f.Level
	}
	return m
}

func healthy() View {
	return View{
		Snapshot: Snapshot{
			Memory: Memory{TotalKB: 16_000_000, AvailableKB: 12_000_000},
			Tuning: Tuning{RmemMax: 16 << 20, RpFilter: 0, Governor: "performance", OpenFiles: 65536},
		},
		Rates: []InterfaceRate{{Interface: Interface{Name: "eth0", Up: true, SpeedMbps: 10000}}},
	}
}

var allTools = []ToolPresence{{"ffmpeg", true}, {"tsduck", true}, {"dvblast", false}}

func TestAHealthyMachineGetsOnlyTheGPUNote(t *testing.T) {
	got := ids(Advise(healthy(), allTools, nil))
	if len(got) != 1 || got["gpu-none"] != "info" {
		t.Fatalf("%v", got)
	}
}

func TestMissingFFmpegAndLowMemoryAreWarnings(t *testing.T) {
	v := healthy()
	v.Memory.AvailableKB = 1_000_000
	got := ids(Advise(v, []ToolPresence{{"ffmpeg", false}}, nil))
	if got["ffmpeg-missing"] != "warn" || got["mem-low"] != "warn" {
		t.Fatalf("%v", got)
	}
}

func TestUDPBufferAdviceEscalatesWhenPacketsAreActuallyLost(t *testing.T) {
	v := healthy()
	v.Tuning.RmemMax = 212992
	if got := ids(Advise(v, allTools, nil)); got["net-rmem-low"] != "info" {
		t.Fatalf("small buffer alone is a hint: %v", got)
	}
	v.RecentUDPDrops = 12
	fs := Advise(v, allTools, nil)
	if ids(fs)["net-rmem-low"] != "warn" {
		t.Fatalf("drops make it a warning: %v", ids(fs))
	}
	for _, f := range fs {
		if f.ID == "net-rmem-low" && (f.Params["drops"] != uint64(12) || f.Params["rmemMax"] != int64(212992)) {
			t.Fatalf("params %v", f.Params)
		}
	}
}

func TestInterfaceFindingsIgnoreVirtualAndDownInterfaces(t *testing.T) {
	v := healthy()
	v.Rates = []InterfaceRate{
		{Interface: Interface{Name: "eth0", Up: true, SpeedMbps: 100}, RecentErrors: 3},
		{Interface: Interface{Name: "docker0", Up: true, Virtual: true}, RecentErrors: 99},
		{Interface: Interface{Name: "eth1", Up: false, SpeedMbps: 10}, RecentErrors: 99},
	}
	fs := Advise(v, allTools, nil)
	var errs, slow int
	for _, f := range fs {
		switch f.ID {
		case "net-errors":
			errs++
			if f.Params["interface"] != "eth0" {
				t.Fatalf("%v", f.Params)
			}
		case "nic-slow":
			slow++
		}
	}
	if errs != 1 || slow != 1 {
		t.Fatalf("errors %d slow %d in %v", errs, slow, ids(fs))
	}
}

func TestRpFilterOnlyMattersWithSeveralPhysicalInterfaces(t *testing.T) {
	v := healthy()
	v.Tuning.RpFilter = 1
	if ids(Advise(v, allTools, nil))["net-rpfilter"] != "" {
		t.Fatal("one NIC does not need it")
	}
	v.Rates = append(v.Rates, InterfaceRate{Interface: Interface{Name: "eth1", Up: true, SpeedMbps: 1000}})
	if ids(Advise(v, allTools, nil))["net-rpfilter"] != "info" {
		t.Fatal("two NICs with strict rp_filter should be flagged")
	}
}

func TestGovernorHint(t *testing.T) {
	v := healthy()
	v.Tuning.Governor = "powersave"
	if ids(Advise(v, allTools, nil))["cpu-governor"] != "info" {
		t.Fatal("powersave should be flagged")
	}
	v.Tuning.Governor = ""
	if ids(Advise(v, allTools, nil))["cpu-governor"] != "" {
		t.Fatal("no cpufreq (virtual machine) means nothing to say")
	}
}

func TestGPUsNeedAMatchingEncoder(t *testing.T) {
	v := healthy()
	v.GPUs = []GPU{{Vendor: "nvidia"}}
	if f := ids(Advise(v, allTools, []string{"libx264"})); f["gpu-encoder-missing"] != "warn" || f["gpu-none"] != "" {
		t.Fatalf("%v", f)
	}
	if f := ids(Advise(v, allTools, []string{"libx264", "h264_nvenc"})); f["gpu-ready"] != "ok" || f["gpu-encoder-missing"] != "" {
		t.Fatalf("%v", f)
	}
	v.GPUs = []GPU{{Vendor: "intel"}}
	fs := Advise(v, allTools, []string{"h264_vaapi"})
	for _, f := range fs {
		if f.ID == "gpu-ready" && f.Params["encoder"] != "h264_vaapi" {
			t.Fatalf("%v", f.Params)
		}
	}
	if ids(fs)["gpu-ready"] != "ok" {
		t.Fatalf("%v", ids(fs))
	}
	v.GPUs = []GPU{{Vendor: "other"}}
	if f := ids(Advise(v, allTools, nil)); f["gpu-encoder-missing"] != "" || f["gpu-ready"] != "" {
		t.Fatalf("an unknown GPU gets no encoder advice: %v", f)
	}
}

func TestDVBAdvice(t *testing.T) {
	v := healthy()
	v.PCICards = []PCICard{{Vendor: "tbs", Device: "544d:6205"}}
	if f := ids(Advise(v, allTools, nil)); f["dvb-driver-missing"] != "warn" {
		t.Fatalf("a card with no driver and no adapters: %v", f)
	}
	v.PCICards = []PCICard{{Vendor: "tbs", Driver: "tbsecp3"}}
	v.DVB = []DVBAdapter{{Index: 0, Frontends: 1}}
	if f := ids(Advise(v, allTools, nil)); f["dvb-ready"] != "ok" || f["dvb-driver-missing"] != "" {
		t.Fatalf("%v", f)
	}
	if f := ids(Advise(v, []ToolPresence{{"ffmpeg", true}}, nil)); f["dvb-tools-missing"] != "warn" {
		t.Fatalf("adapters without tsp or dvblast: %v", f)
	}
}
