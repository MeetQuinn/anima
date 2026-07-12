import DefaultTheme from "vitepress/theme";
import { h, onBeforeUnmount, onMounted } from "vue";
import "./architecture.css";
import "./docs-home.css";
import "./landing.css";
import "./how-it-works.css";

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

        // /how-it-works film: click-to-play with a poster (no autoplay, so the
        // reduced-motion experience is the default). The video carries no
        // `controls` until first play, so there is no native dead-center play
        // button competing with our center-high overlay glyph. After play we
        // hand off to native controls for scrub/pause/replay.
        const playButton = target.closest<HTMLButtonElement>(
          "button[data-play-video]",
        );
        if (playButton) {
          const video =
            playButton.parentElement?.querySelector<HTMLVideoElement>("video");
          if (video) {
            video.setAttribute("controls", "");
            playButton.hidden = true;
            void video.play();
          }
          return;
        }

        // Matches both the raw-command Copy button and the secondary
        // "Share it with your team" handoff button (copies a link to send on).
        const button = target.closest<HTMLButtonElement>(
          "button[data-command]",
        );
        if (!button) return;

        const command = button.dataset.command ?? INSTALL_COMMAND;
        const originalText = button.textContent ?? "Copy";
        const copiedLabel = button.dataset.copiedLabel ?? "Copied";
        try {
          await copyToClipboard(command);
          button.textContent = copiedLabel;
        } catch {
          button.textContent = "Copy failed";
        } finally {
          window.setTimeout(() => {
            button.textContent = originalText;
          }, 1600);
        }
      };

      // Landing scroll reveal. CSS hides [data-reveal] elements only once
      // <html> carries .reveal-ready (added here), so a no-JS render and
      // crawlers always see the full page. Each element reveals once when it
      // enters the viewport; per-element stagger comes from --reveal-delay.
      let observer: IntersectionObserver | undefined;
      const observeReveals = () => {
        const targets = document.querySelectorAll<HTMLElement>(
          ".landing-home [data-reveal]",
        );
        if (
          targets.length === 0 ||
          typeof IntersectionObserver === "undefined"
        ) {
          return;
        }
        document.documentElement.classList.add("reveal-ready");
        observer = new IntersectionObserver(
          (entries, self) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              entry.target.classList.add("is-revealed");
              self.unobserve(entry.target);
            }
          },
          { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
        );
        for (const target of targets) observer.observe(target);
      };

      onMounted(() => {
        document.addEventListener("click", handleClick);
        observeReveals();
      });
      onBeforeUnmount(() => {
        document.removeEventListener("click", handleClick);
        observer?.disconnect();
      });

      return () => h(DefaultTheme.Layout);
    },
  },
};
