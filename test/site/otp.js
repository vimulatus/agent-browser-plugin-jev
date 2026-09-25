/**
 * Wires a six-box code form. With `advance`, a box that receives several digits spreads them over the boxes
 * after it and focus moves to the next empty box, as a pasted code does in most OTP widgets. Without it,
 * each box keeps its first digit and focus stays put. `onCode` gets the six boxes joined, on submit.
 */
function otpBoxes(form, { advance, onCode }) {
  const boxes = [...form.querySelectorAll(".boxes input")];
  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      const digits = box.value.replace(/\D/g, "");
      if (!advance) {
        box.value = digits.slice(0, 1);
        return;
      }
      box.value = "";
      [...digits].slice(0, boxes.length - i).forEach((digit, k) => (boxes[i + k].value = digit));
      (boxes.find((b) => b.value === "") ?? boxes.at(-1)).focus();
    });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onCode(boxes.map((b) => b.value).join(""));
  });
}
