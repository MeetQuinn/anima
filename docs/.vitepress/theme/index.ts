import DefaultTheme from "vitepress/theme";
import { h, onBeforeUnmount, onMounted } from "vue";
import "./landing.css";

const INSTALL_COMMAND = "curl -fsSL https://anima.meetquinn.ai/install.sh | sh";

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export default {
  ...DefaultTheme,
  Layout: {
    setup() {
      const handleClick = async (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>(
          ".landing-copy-command",
        );
        if (!button) return;

        const command = button.dataset.command ?? INSTALL_COMMAND;
        const originalText = button.textContent ?? "Copy";
        try {
          await copyToClipboard(command);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        } finally {
          window.setTimeout(() => {
            button.textContent = originalText;
          }, 1400);
        }
      };

      onMounted(() => document.addEventListener("click", handleClick));
      onBeforeUnmount(() => document.removeEventListener("click", handleClick));

      return () => h(DefaultTheme.Layout);
    },
  },
};
