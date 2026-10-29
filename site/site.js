const menu = document.querySelector(".mobile-menu");
const narrow = window.matchMedia("(max-width: 899px)");
const resizeMenu = () => {
  menu.open = !narrow.matches;
};
resizeMenu();
document.documentElement.classList.add("enhanced");
narrow.addEventListener("change", resizeMenu);

for (const code of document.querySelectorAll("pre > code")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code sample");
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select to copy";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 2000);
  });
  code.parentElement.append(button);
}

const links = [...document.querySelectorAll(".outline a")];
const headings = links.map((link) =>
  document.getElementById(decodeURIComponent(link.hash.slice(1))),
);
let queued = false;
function updateOutline() {
  let current = 0;
  headings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top <= 130) current = index;
  });
  links.forEach((link, index) => {
    if (index === current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  queued = false;
}
window.addEventListener(
  "scroll",
  () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(updateOutline);
    }
  },
  { passive: true },
);
updateOutline();
