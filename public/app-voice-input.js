import { getLocale, onLocaleChange, t } from "./i18n.js";

export function setupVoiceInput({ micBtn, messageInput }) {
  if (!micBtn || !messageInput) return;
  let recognition = null;
  let isRecording = false;

  if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = getLocale() === "zh" ? "zh-CN" : "en-AU";

    let finalTranscript = "";
    let interimTranscript = "";

    recognition.addEventListener("result", (e) => {
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
      if (isRecording) stopRecording();
    });

    recognition.addEventListener("error", (e) => {
      console.error("[Voice] Error:", e.error);
      stopRecording();
    });

    micBtn.addEventListener("click", () => {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    function startRecording() {
      finalTranscript = messageInput.value;
      interimTranscript = "";
      isRecording = true;
      micBtn.classList.add("recording");
      micBtn.title = t("voice.stopRecording");
      recognition.start();
      messageInput.focus();
    }

    function stopRecording() {
      isRecording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("voice.voiceInput");
      try {
        recognition.stop();
      } catch {}
      messageInput.value = finalTranscript;
      messageInput.dispatchEvent(new Event("input"));
      messageInput.focus();
    }
  } else {
    micBtn.style.display = "none";
  }

  onLocaleChange(() => {
    if (!micBtn) return;
    micBtn.title = isRecording ? t("voice.stopRecording") : t("voice.voiceInput");
  });
}
