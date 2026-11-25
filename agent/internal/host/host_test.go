package host

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func put(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const netDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: %d 500 %d %d 0 0 0 0 %d 400 0 0 0 0 0 0
docker0: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0
`

func machine(t *testing.T) string {
	root := t.TempDir()
	put(t, root, "proc/cpuinfo", "processor\t: 0\nmodel name\t: Intel(R) Xeon(R) E-2236\n\nprocessor\t: 1\nmodel name\t: Intel(R) Xeon(R) E-2236\n")
	put(t, root, "proc/stat", "cpu  100 0 100 700 100 0 0 0\ncpu0 1 1 1 1 1\n")
	put(t, root, "proc/meminfo", "MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n")
	put(t, root, "proc/uptime", "12345.67 9999.0\n")
	put(t, root, "proc/loadavg", "0.52 0.40 0.30 1/200 999\n")
	put(t, root, "proc/net/dev", fmt.Sprintf(netDev, 1_000_000, 0, 0, 2_000_000))
	put(t, root, "proc/net/snmp", "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\nUdp: 5000 1 7 4000 3 0\n")
	put(t, root, "sys/class/net/eth0/operstate", "up\n")
	put(t, root, "sys/class/net/eth0/speed", "1000\n")
	put(t, root, "sys/class/net/eth0/device/vendor", "x")
	put(t, root, "sys/class/net/lo/operstate", "unknown\n")
	put(t, root, "sys/class/net/docker0/operstate", "up\n")
	put(t, root, "proc/sys/net/core/rmem_max", "212992\n")
	put(t, root, "proc/sys/net/ipv4/conf/all/rp_filter", "1\n")
	put(t, root, "sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "powersave\n")
	return root
}

func TestReadsCPUMemoryNetworkAndTuning(t *testing.T) {
	s := Read(machine(t))
	if s.CPU.Model != "Intel(R) Xeon(R) E-2236" || s.CPU.Cores != 2 {
		t.Fatalf("%+v", s.CPU)
	}
	if s.Memory.TotalKB != 16000000 || s.Memory.AvailableKB != 8000000 || s.UptimeSec != 12345 || s.Load[0] != 0.52 {
		t.Fatalf("%+v %d %v", s.Memory, s.UptimeSec, s.Load)
	}
	if s.CPUTotal != 1000 || s.CPUBusy != 200 { // busy = total - idle - iowait
		t.Fatalf("cpu counters %d/%d", s.CPUBusy, s.CPUTotal)
	}
	byName := map[string]Interface{}
	for _, i := range s.Interfaces {
		byName[i.Name] = i
	}
	eth := byName["eth0"]
	if !eth.Up || eth.SpeedMbps != 1000 || eth.Virtual || eth.RxBytes != 1_000_000 || eth.TxBytes != 2_000_000 {
		t.Fatalf("eth0 %+v", eth)
	}
	if !byName["lo"].Virtual || !byName["docker0"].Virtual {
		t.Fatal("loopback and bridges are virtual")
	}
	if s.UDP.InErrors != 7 || s.UDP.RcvbufErrors != 3 || s.UDP.InDatagrams != 5000 {
		t.Fatalf("%+v", s.UDP)
	}
	if s.Tuning.RmemMax != 212992 || s.Tuning.RpFilter != 1 || s.Tuning.Governor != "powersave" {
		t.Fatalf("%+v", s.Tuning)
	}
	if s.Tuning.IGMPv != -1 {
		t.Fatalf("missing values are -1, got %d", s.Tuning.IGMPv)
	}
}

func TestMissingFilesGiveEmptyValuesNotPanics(t *testing.T) {
	s := Read(t.TempDir())
	if s.CPU.Cores != 0 || len(s.Interfaces) != 0 || s.Tuning.RmemMax != -1 || s.UptimeSec != 0 {
		t.Fatalf("%+v", s)
	}
}

func pci(t *testing.T, root, addr, class, vendor, device, driver string) {
	put(t, root, "sys/bus/pci/devices/"+addr+"/class", class+"\n")
	put(t, root, "sys/bus/pci/devices/"+addr+"/vendor", vendor+"\n")
	put(t, root, "sys/bus/pci/devices/"+addr+"/device", device+"\n")
	if driver != "" {
		_ = os.Symlink("../../../bus/pci/drivers/"+driver, filepath.Join(root, "sys/bus/pci/devices", addr, "driver"))
	}
}

func TestFindsGPUsAndDVBCards(t *testing.T) {
	root := t.TempDir()
	pci(t, root, "0000:01:00.0", "0x030000", "0x10de", "0x1f82", "nvidia")
	pci(t, root, "0000:00:02.0", "0x030000", "0x8086", "0x3e92", "i915")
	pci(t, root, "0000:03:00.0", "0x048000", "0x544d", "0x6205", "") // TBS card without driver
	pci(t, root, "0000:04:00.0", "0x020000", "0x8086", "0x15b8", "e1000e")
	put(t, root, "dev/dri/renderD128", "")
	put(t, root, "dev/dri/renderD129", "")
	s := Read(root)
	if len(s.GPUs) != 2 {
		t.Fatalf("%+v", s.GPUs)
	}
	vendors := map[string]bool{}
	for _, g := range s.GPUs {
		vendors[g.Vendor] = true
		if g.Render == "" {
			t.Errorf("%+v has no render node", g)
		}
	}
	if !vendors["nvidia"] || !vendors["intel"] {
		t.Fatalf("%v", vendors)
	}
	if len(s.PCICards) != 1 || s.PCICards[0].Vendor != "tbs" || s.PCICards[0].Driver != "" {
		t.Fatalf("%+v", s.PCICards)
	}
}

func TestFindsDVBAdapters(t *testing.T) {
	root := t.TempDir()
	put(t, root, "dev/dvb/adapter0/frontend0", "")
	put(t, root, "dev/dvb/adapter0/frontend1", "")
	put(t, root, "dev/dvb/adapter1/frontend0", "")
	put(t, root, "dev/dvb/notanadapter/x", "")
	put(t, root, "sys/class/dvb/dvb0.frontend0/device/vendor", "0x544d\n")
	put(t, root, "sys/class/dvb/dvb0.frontend0/device/device", "0x6205\n")
	a := Read(root).DVB
	if len(a) != 2 || a[0].Frontends != 2 || a[0].Vendor != "tbs" || a[0].Device != "544d:6205" || a[1].Frontends != 1 {
		t.Fatalf("%+v", a)
	}
}

func TestMonitorComputesRatesUsageAndRecentLoss(t *testing.T) {
	root := machine(t)
	m := NewMonitor(root, time.Second, nil, nil)
	start := time.Now()
	m.Sample(start)
	// 10 s later eth0 moved 12.5 MB in and 25 MB out, had 4 drops, UDP overflowed 5 more times, CPU did 600 busy of 1000.
	put(t, root, "proc/net/dev", fmt.Sprintf(netDev, 1_000_000+12_500_000, 0, 4, 2_000_000+25_000_000))
	put(t, root, "proc/net/snmp", "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\nUdp: 9000 1 12 4000 8 0\n")
	put(t, root, "proc/stat", "cpu  700 0 100 1100 100 0 0 0\n")
	m.Sample(start.Add(10 * time.Second))
	v := m.View()
	var eth InterfaceRate
	for _, r := range v.Rates {
		if r.Name == "eth0" {
			eth = r
		}
	}
	if eth.RxBps != 10_000_000 || eth.TxBps != 20_000_000 {
		t.Fatalf("rates %d/%d", eth.RxBps, eth.TxBps)
	}
	if eth.RecentErrors != 4 || v.RecentUDPDrops != 5 {
		t.Fatalf("recent loss %d / %d", eth.RecentErrors, v.RecentUDPDrops)
	}
	if v.CPUUsage < 59 || v.CPUUsage > 61 {
		t.Fatalf("cpu usage %.1f", v.CPUUsage)
	}
}

func TestCountersThatGoBackwardsDoNotProduceHugeRates(t *testing.T) {
	root := machine(t)
	m := NewMonitor(root, time.Second, nil, nil)
	now := time.Now()
	m.Sample(now)
	put(t, root, "proc/net/dev", fmt.Sprintf(netDev, 10, 0, 0, 10)) // interface was reset
	m.Sample(now.Add(2 * time.Second))
	for _, r := range m.View().Rates {
		if r.RxBps > 1_000_000_000 || r.TxBps > 1_000_000_000 {
			t.Fatalf("wrapped rate %+v", r)
		}
	}
}

func TestOldSamplesAreDropped(t *testing.T) {
	m := NewMonitor(machine(t), time.Second, nil, nil)
	now := time.Now()
	for i := 0; i < 200; i++ {
		m.Sample(now.Add(time.Duration(i) * 2 * time.Second))
	}
	m.mu.Lock()
	n := len(m.samples)
	m.mu.Unlock()
	if n > 40 {
		t.Fatalf("%d samples kept", n)
	}
}

func TestEmptyOrMalformedFilesNeverPanic(t *testing.T) {
	root := t.TempDir()
	for _, f := range []string{"proc/uptime", "proc/meminfo", "proc/loadavg", "proc/stat", "proc/cpuinfo", "proc/net/dev", "proc/net/snmp", "proc/self/limits"} {
		put(t, root, f, "")
	}
	put(t, root, "proc/meminfo", "MemTotal:\nMemAvailable: abc kB\n")
	put(t, root, "proc/stat", "cpu\ncpu 1 2\n")
	put(t, root, "proc/net/dev", "weird: 1 2 3\nnocolon\n")
	put(t, root, "proc/net/snmp", "Udp: A B\nUdp: 1\n")
	put(t, root, "proc/self/limits", "Max open files\n")
	_ = Read(root)
}

func TestListsAreNeverNil(t *testing.T) {
	s := Read(t.TempDir())
	if s.Interfaces == nil || s.GPUs == nil || s.DVB == nil || s.PCICards == nil {
		t.Fatalf("nil list in %+v", s)
	}
	m := NewMonitor(t.TempDir(), time.Second, nil, nil)
	if v := m.View(); v.Rates == nil || v.Findings == nil {
		t.Fatalf("nil list in view %+v", v)
	}
}
