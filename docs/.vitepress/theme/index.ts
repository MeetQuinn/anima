import DefaultTheme from "vitepress/theme";
import { h, onBeforeUnmount, onMounted } from "vue";
import "./architecture.css";
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

      // Pause the hero relay loop while it is scrolled out of view, so it does
      // not burn battery/CPU on mobile when nobody is looking at it.
      let observer: IntersectionObserver | undefined;
      const observeHeroLoop = () => {
        const thread = document.querySelector<HTMLElement>(".hero-relay-thread");
        if (!thread || typeof IntersectionObserver === "undefined") return;
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              thread.style.animationPlayState = entry.isIntersecting
                ? "running"
                : "paused";
            }
          },
          { threshold: 0 },
        );
        observer.observe(thread);
      };

      onMounted(() => {
        document.addEventListener("click", handleClick);
        observeHeroLoop();
      });
      onBeforeUnmount(() => {
        document.removeEventListener("click", handleClick);
        observer?.disconnect();
      });

      return () => h(DefaultTheme.Layout);
    },
  },
};
