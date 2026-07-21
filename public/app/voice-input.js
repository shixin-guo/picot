// ABOUTME: Wires the microphone button to the speech-recognition API for one composer.
// ABOUTME: Returns an idempotent cleanup function for reusable view teardown.

import { getLocale, onLocaleChange, t } from "../i18n.js";

export function setupVoiceInput({ micBtn, messageInput }) {
  // Missing elements (unsupported/unused composer) still yield a no-op cleanup
  // so callers can always assign `const destroy = setupVoiceInput(...)`.
  if (!micBtn || !messageInput) {
    return () => {};
  }

  let recognition = null;
  let isRecording = false;
  let destroyed = false;
  let clickHandler = null;

  const supported =
    typeof window.SpeechRecognition === "function" ||
    typeof window.webkitSpeechRecognition === "function";

  if (supported) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = getLocale() === "zh" ? "zh-CN" : "en-AU";

    let finalTranscript = "";
    let interimTranscript = "";

    recognition.addEventListener("result", (e) => {
      if (destroyed) return;
      interimTranscript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript;
        } else {
          interimTranscript += e.results[i][0].transcript;
        }
      }
      messageInput.value = finalTranscript + interimTranscript;
      messageInput.dispatchEvent(new Event("input"));
    });

    recognition.addEventListener("end", () => {
      if (destroyed) return;
      if (isRecording) stopRecording();
    });

    recognition.addEventListener("error", (e) => {
      if (destroyed) return;
      console.error("[Voice] Error:", e.error);
      stopRecording();
    });

    clickHandler = () => {
      if (destroyed) return;
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    };
    micBtn.addEventListener("click", clickHandler);

    function startRecording() {
      finalTranscript = messageInput.value;
      interimTranscript = "";
      isRecording = true;
      micBtn.classList.add("recording");
      micBtn.title = t("voice.stopRecording");
      micBtn.setAttribute("aria-label", t("voice.stopRecording"));
      recognition.start();
      messageInput.focus();
    }

    function stopRecording() {
      isRecording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("voice.voiceInput");
      micBtn.setAttribute("aria-label", t("voice.voiceInput"));
      try {
        recognition.stop();
      } catch {
        // ignore stop errors during teardown
      }
      messageInput.value = finalTranscript;
      messageInput.dispatchEvent(new Event("input"));
      messageInput.focus();
    }
  } else {
    micBtn.style.display = "none";
  }

  const unsubscribeLocale = onLocaleChange(() => {
    if (destroyed || !micBtn) return;
    const key = isRecording ? "voice.stopRecording" : "voice.voiceInput";
    micBtn.title = t(key);
    micBtn.setAttribute("aria-label", t(key));
  });

  return function destroyVoiceInput() {
    if (destroyed) return;
    destroyed = true;
    if (isRecording && recognition) {
      isRecording = false;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      micBtn.classList.remove("recording");
    }
    if (clickHandler && micBtn) {
      micBtn.removeEventListener("click", clickHandler);
    }
    clickHandler = null;
    if (typeof unsubscribeLocale === "function") {
      unsubscribeLocale();
    }
  };
}
