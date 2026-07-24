export function setupComposerSubmitHandling({ input, form, onSubmit }) {
  if (!input || !form) return { dispose() {} };

  let isComposingInput = false;
  let compositionResetTimer = null;

  function clearCompositionReset() {
    if (compositionResetTimer === null) return;
    clearTimeout(compositionResetTimer);
    compositionResetTimer = null;
  }

  function isImeComposing(event = null) {
    return Boolean(event?.isComposing || event?.keyCode === 229 || isComposingInput);
  }

  function onCompositionStart() {
    clearCompositionReset();
    isComposingInput = true;
  }

  function onCompositionEnd() {
    clearCompositionReset();
    // WebKit fires compositionend before the confirming keydown, so
    // event.isComposing is already false by the time keydown runs. Delay the
    // reset so the flag survives that keydown and its default form submit.
    compositionResetTimer = setTimeout(() => {
      isComposingInput = false;
      compositionResetTimer = null;
    }, 0);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (isImeComposing(event)) return;
    event.preventDefault();
    onSubmit({ altKey: event.altKey });
  }

  function onFormSubmit(event) {
    event.preventDefault();
    if (isImeComposing()) return;
    onSubmit({ altKey: false });
  }

  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("keydown", onKeyDown);
  form.addEventListener("submit", onFormSubmit);

  return {
    dispose() {
      clearCompositionReset();
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("keydown", onKeyDown);
      form.removeEventListener("submit", onFormSubmit);
    },
  };
}
