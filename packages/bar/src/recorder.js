// Voice notes: MediaRecorder for the audio that gets transcribed on the
// server, and the browser's speech recognition (where it exists) only for the
// live caption, so the owner can see they're being heard (LIVE-EDITS.md §2.1).

export const canRecord = () =>
  typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;

function pickMime() {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

export async function startRecording({ onCaption, onLevel }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);

  // Level meter.
  let raf;
  let ctx;
  try {
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      onLevel?.(Math.min(1, peak / 64));
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    /* no meter, still records */
  }

  // Live caption.
  let finalText = '';
  let interim = '';
  let recognition;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Recognition) {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      onCaption?.((finalText + interim).trim());
    };
    recognition.onend = () => {
      // Chrome stops after silences; keep listening while recording.
      if (recorder.state === 'recording') {
        try {
          recognition.start();
        } catch {
          /* already restarting */
        }
      }
    };
    try {
      recognition.start();
    } catch {
      recognition = null;
    }
  }

  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          cancelAnimationFrame(raf);
          ctx?.close();
          const type = recorder.mimeType || mimeType || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), type, caption: (finalText + interim).trim() });
        };
        try {
          recognition?.abort();
        } catch {
          /* ignore */
        }
        recorder.stop();
      }),
  };
}
