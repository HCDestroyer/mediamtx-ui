/** Spanish labels for the source and reader types reported by the API. */
const SOURCE_LABELS: Record<string, string> = {
  hlsSource: "HLS (extrae)",
  mpegtsSource: "MPEG-TS / UDP",
  rtpSource: "RTP",
  rtmpSource: "RTMP (extrae)",
  rtspSource: "RTSP (extrae)",
  srtSource: "SRT (extrae)",
  webRTCSource: "WebRTC (extrae)",
  moqSource: "MoQ (extrae)",
  rpiCameraSource: "Cámara Raspberry Pi",
  redirect: "Redirección",
  rtmpConn: "RTMP (publicador)",
  rtmpsConn: "RTMPS (publicador)",
  rtspSession: "RTSP (publicador)",
  rtspsSession: "RTSPS (publicador)",
  srtConn: "SRT (publicador)",
  webRTCSession: "WebRTC (publicador)",
  moqSession: "MoQ (publicador)",
};

const READER_LABELS: Record<string, string> = {
  hlsSession: "HLS",
  rtmpConn: "RTMP",
  rtmpsConn: "RTMPS",
  rtspConn: "RTSP",
  rtspSession: "RTSP",
  rtspsConn: "RTSPS",
  rtspsSession: "RTSPS",
  srtConn: "SRT",
  webRTCSession: "WebRTC",
  moqSession: "MoQ",
  hidden: "Interno",
};

export const sourceLabel = (type: string): string => SOURCE_LABELS[type] ?? type;
export const readerLabel = (type: string): string => READER_LABELS[type] ?? type;
