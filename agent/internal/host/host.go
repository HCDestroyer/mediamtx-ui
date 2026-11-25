// Package host reads what the agent can learn about the machine it runs on, straight from /proc and
// /sys (no external tools): CPU and memory, network interfaces and UDP loss counters, GPUs, DVB cards
// and the kernel settings that matter for transport streams. Paths are relative to a root directory so
// tests can build a fake machine.
package host

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// CPU describes the processor.
type CPU struct {
	Model string `json:"model"`
	Cores int    `json:"cores"`
}

// Memory in kilobytes, as /proc/meminfo reports it.
type Memory struct {
	TotalKB     int64 `json:"totalKB"`
	AvailableKB int64 `json:"availableKB"`
}

// Interface is a network interface with its cumulative counters.
type Interface struct {
	Name      string `json:"name"`
	Up        bool   `json:"up"`
	SpeedMbps int    `json:"speedMbps"` // 0 when unknown
	// Virtual interfaces (loopback, bridges, veth, tunnels) have no physical device behind them.
	Virtual   bool   `json:"virtual"`
	RxBytes   uint64 `json:"rxBytes"`
	TxBytes   uint64 `json:"txBytes"`
	RxErrors  uint64 `json:"rxErrors"`
	RxDropped uint64 `json:"rxDropped"`
	TxErrors  uint64 `json:"txErrors"`
	TxDropped uint64 `json:"txDropped"`
}

// UDP counters from /proc/net/snmp. RcvbufErrors counts datagrams dropped because the socket buffer was
// full: the classic cause of broken multicast video.
type UDP struct {
	InDatagrams  uint64 `json:"inDatagrams"`
	InErrors     uint64 `json:"inErrors"`
	RcvbufErrors uint64 `json:"rcvbufErrors"`
}

// GPU found on the PCI bus.
type GPU struct {
	Vendor string `json:"vendor"` // nvidia, intel, amd, other
	Device string `json:"device"` // PCI id
	// Render is the render node (/dev/dri/renderD*) video encoders use, empty when there is none.
	Render string `json:"render,omitempty"`
}

// DVBAdapter is a /dev/dvb/adapterN with its frontends.
type DVBAdapter struct {
	Index     int    `json:"index"`
	Frontends int    `json:"frontends"`
	Vendor    string `json:"vendor,omitempty"` // tbs, digital-devices, other
	Device    string `json:"device,omitempty"`
}

// PCICard is a multimedia PCI device that looks like a DVB card, whether or not it has a driver.
type PCICard struct {
	Vendor string `json:"vendor"`
	Device string `json:"device"`
	Driver string `json:"driver,omitempty"`
}

// Tuning holds kernel settings that affect transport streams. -1 means unknown.
type Tuning struct {
	RmemMax   int64  `json:"rmemMax"`
	RpFilter  int    `json:"rpFilter"`
	IGMPv     int    `json:"igmpVersion"`
	Governor  string `json:"governor"`
	OpenFiles int64  `json:"openFiles"`
	IPForward int    `json:"ipForward"`
}

// Snapshot is everything static plus the cumulative counters; rates come from comparing two snapshots.
type Snapshot struct {
	CPU        CPU          `json:"cpu"`
	Memory     Memory       `json:"memory"`
	UptimeSec  int64        `json:"uptimeSec"`
	Load       [3]float64   `json:"load"`
	CPUBusy    uint64       `json:"-"`
	CPUTotal   uint64       `json:"-"`
	Interfaces []Interface  `json:"interfaces"`
	UDP        UDP          `json:"udp"`
	GPUs       []GPU        `json:"gpus"`
	DVB        []DVBAdapter `json:"dvb"`
	PCICards   []PCICard    `json:"pciCards"`
	Tuning     Tuning       `json:"tuning"`
}

// Read takes a snapshot of the machine rooted at root ("/" in production).
func Read(root string) Snapshot {
	s := Snapshot{}
	s.CPU, s.CPUBusy, s.CPUTotal = readCPU(root)
	s.Memory = readMemory(root)
	s.UptimeSec = int64(firstFloat(readFile(root, "proc/uptime")))
	s.Load = readLoad(root)
	s.Interfaces = readInterfaces(root)
	s.UDP = readUDP(root)
	s.GPUs, s.PCICards = readPCI(root)
	s.DVB = readDVB(root)
	s.Tuning = readTuning(root)
	// Empty lists are sent as [] rather than null.
	if s.Interfaces == nil {
		s.Interfaces = []Interface{}
	}
	if s.GPUs == nil {
		s.GPUs = []GPU{}
	}
	if s.PCICards == nil {
		s.PCICards = []PCICard{}
	}
	if s.DVB == nil {
		s.DVB = []DVBAdapter{}
	}
	return s
}

func readFile(root, rel string) string {
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		return ""
	}
	return string(data)
}

func trim(s string) string { return strings.TrimSpace(s) }

// firstField returns the first whitespace-separated word, or "" for empty input.
func firstField(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return ""
}

func firstFloat(s string) float64 {
	f, _ := strconv.ParseFloat(firstField(s), 64)
	return f
}

func readCPU(root string) (cpu CPU, busy, total uint64) {
	for _, line := range strings.Split(readFile(root, "proc/cpuinfo"), "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch trim(key) {
		case "model name":
			if cpu.Model == "" {
				cpu.Model = trim(val)
			}
		case "processor":
			cpu.Cores++
		}
	}
	for _, line := range strings.Split(readFile(root, "proc/stat"), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		var v []uint64
		for _, x := range f[1:] {
			n, _ := strconv.ParseUint(x, 10, 64)
			v = append(v, n)
		}
		for _, n := range v {
			total += n
		}
		idle := v[3]
		if len(v) > 4 {
			idle += v[4] // iowait counts as idle
		}
		busy = total - idle
		break
	}
	return
}

func readMemory(root string) Memory {
	var m Memory
	for _, line := range strings.Split(readFile(root, "proc/meminfo"), "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(firstField(val), 10, 64)
		switch key {
		case "MemTotal":
			m.TotalKB = n
		case "MemAvailable":
			m.AvailableKB = n
		}
	}
	return m
}

func readLoad(root string) (l [3]float64) {
	f := strings.Fields(readFile(root, "proc/loadavg"))
	for i := 0; i < 3 && i < len(f); i++ {
		l[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return
}

func readInterfaces(root string) []Interface {
	var out []Interface
	sc := bufio.NewScanner(strings.NewReader(readFile(root, "proc/net/dev")))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // header lines have no colon
		}
		name = trim(name)
		f := strings.Fields(rest)
		if len(f) < 16 {
			continue
		}
		num := func(i int) uint64 { n, _ := strconv.ParseUint(f[i], 10, 64); return n }
		ifc := Interface{
			Name: name, RxBytes: num(0), RxErrors: num(2), RxDropped: num(3), TxBytes: num(8), TxErrors: num(10), TxDropped: num(11),
		}
		base := "sys/class/net/" + name
		state := trim(readFile(root, base+"/operstate"))
		ifc.Up = state == "up" || (state == "unknown" && name != "lo")
		if n, err := strconv.Atoi(trim(readFile(root, base+"/speed"))); err == nil && n > 0 {
			ifc.SpeedMbps = n
		}
		_, err := os.Stat(filepath.Join(root, base, "device"))
		ifc.Virtual = err != nil
		out = append(out, ifc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func readUDP(root string) UDP {
	var heads, vals []string
	for _, line := range strings.Split(readFile(root, "proc/net/snmp"), "\n") {
		if strings.HasPrefix(line, "Udp:") {
			if heads == nil {
				heads = strings.Fields(line)[1:]
			} else {
				vals = strings.Fields(line)[1:]
			}
		}
	}
	var u UDP
	for i, h := range heads {
		if i >= len(vals) {
			break
		}
		n, _ := strconv.ParseUint(vals[i], 10, 64)
		switch h {
		case "InDatagrams":
			u.InDatagrams = n
		case "InErrors":
			u.InErrors = n
		case "RcvbufErrors":
			u.RcvbufErrors = n
		}
	}
	return u
}

func vendorName(id string) string {
	switch strings.ToLower(id) {
	case "0x10de":
		return "nvidia"
	case "0x8086":
		return "intel"
	case "0x1002", "0x1022":
		return "amd"
	case "0x544d":
		return "tbs"
	case "0xdd01":
		return "digital-devices"
	}
	return "other"
}

// readPCI finds GPUs (class 0x03) and multimedia cards (class 0x04) by their PCI ids.
func readPCI(root string) (gpus []GPU, cards []PCICard) {
	dir := filepath.Join(root, "sys/bus/pci/devices")
	entries, _ := os.ReadDir(dir)
	renders := renderNodes(root)
	nextRender := 0
	for _, e := range entries {
		base := "sys/bus/pci/devices/" + e.Name()
		class := trim(readFile(root, base+"/class"))
		vendor, device := trim(readFile(root, base+"/vendor")), trim(readFile(root, base+"/device"))
		switch {
		case strings.HasPrefix(class, "0x03"):
			g := GPU{Vendor: vendorName(vendor), Device: strings.TrimPrefix(vendor, "0x") + ":" + strings.TrimPrefix(device, "0x")}
			if nextRender < len(renders) {
				g.Render = renders[nextRender]
				nextRender++
			}
			gpus = append(gpus, g)
		case strings.HasPrefix(class, "0x04"):
			v := vendorName(vendor)
			if v == "tbs" || v == "digital-devices" || strings.HasPrefix(class, "0x0480") {
				c := PCICard{Vendor: v, Device: strings.TrimPrefix(vendor, "0x") + ":" + strings.TrimPrefix(device, "0x")}
				if target, err := os.Readlink(filepath.Join(root, base, "driver")); err == nil {
					c.Driver = filepath.Base(target)
				}
				cards = append(cards, c)
			}
		}
	}
	return
}

func renderNodes(root string) []string {
	matches, _ := filepath.Glob(filepath.Join(root, "dev/dri/renderD*"))
	sort.Strings(matches)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, "/dev/dri/"+filepath.Base(m))
	}
	return out
}

func readDVB(root string) []DVBAdapter {
	entries, _ := os.ReadDir(filepath.Join(root, "dev/dvb"))
	var out []DVBAdapter
	for _, e := range entries {
		idx, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "adapter"))
		if err != nil || !strings.HasPrefix(e.Name(), "adapter") {
			continue
		}
		a := DVBAdapter{Index: idx}
		fronts, _ := filepath.Glob(filepath.Join(root, "dev/dvb", e.Name(), "frontend*"))
		a.Frontends = len(fronts)
		dev := "sys/class/dvb/dvb" + strconv.Itoa(idx) + ".frontend0/device"
		if v := trim(readFile(root, dev+"/vendor")); v != "" {
			a.Vendor = vendorName(v)
			a.Device = strings.TrimPrefix(v, "0x") + ":" + strings.TrimPrefix(trim(readFile(root, dev+"/device")), "0x")
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

func intOr(s string, def int64) int64 {
	n, err := strconv.ParseInt(trim(s), 10, 64)
	if err != nil {
		return def
	}
	return n
}

func readTuning(root string) Tuning {
	t := Tuning{
		RmemMax:   intOr(readFile(root, "proc/sys/net/core/rmem_max"), -1),
		RpFilter:  int(intOr(readFile(root, "proc/sys/net/ipv4/conf/all/rp_filter"), -1)),
		IGMPv:     int(intOr(readFile(root, "proc/sys/net/ipv4/conf/all/force_igmp_version"), -1)),
		IPForward: int(intOr(readFile(root, "proc/sys/net/ipv4/ip_forward"), -1)),
		Governor:  trim(readFile(root, "sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")),
		OpenFiles: -1,
	}
	for _, line := range strings.Split(readFile(root, "proc/self/limits"), "\n") {
		if strings.HasPrefix(line, "Max open files") {
			if f := strings.Fields(line); len(f) >= 4 {
				t.OpenFiles = intOr(f[3], -1)
			}
		}
	}
	return t
}
