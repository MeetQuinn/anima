---
layout: home
pageClass: landing-home
---

<!--
  SCAFFOLD ONLY. Every visible string below is an obviously-fake placeholder
  ([ZH 待译 · ...] / lorem), here so the real Chinese copy can be iterated on the
  live rendered layout. No claim in this file is real until Aria's voice pass
  clears Iris's red-line and Tess's accuracy gate. The HTML structure, classes,
  aria attributes, and images mirror docs/index.md so styling stays in lockstep.
  Links and the install command are kept real (language-neutral); guide links
  point at the English guide as a stopgap until zh guide pages exist.
-->

<main class="landing-shell">
  <section class="landing-hero" aria-labelledby="landing-title">
    <div class="landing-hero-copy">
      <h1 id="landing-title">[ZH 待译 · 主标题 / PLACEHOLDER hero headline]</h1>
      <p class="landing-tagline">
        [ZH 待译 · 副标题 / PLACEHOLDER tagline] Lorem ipsum dolor sit amet, consectetur adipiscing elit.
      </p>
      <div class="landing-actions" aria-label="Primary links">
        <a class="landing-button landing-button-primary" href="/guide/quickstart">[ZH 待译 · 开始使用]</a>
      </div>
    </div>
    <div class="landing-hero-visual">
      <div class="hero-proof-frame">
        <picture>
          <source media="(max-width: 620px)" srcset="/landing/ember-ship-thread-compact.png">
          <img src="/landing/ember-ship-thread.png" alt="[ZH 待译 · 图片描述 / PLACEHOLDER image alt]">
        </picture>
      </div>
    </div>
  </section>

  <section class="landing-card-section" aria-labelledby="cards-title">
    <div class="landing-section-heading">
      <p>[ZH 待译 · 栏目标签]</p>
      <h2 id="cards-title">[ZH 待译 · 栏目标题 / PLACEHOLDER section title]</h2>
    </div>
    <div class="landing-cards">
      <article class="landing-card-featured">
        <h2>[ZH 待译 · 卡片一标题]</h2>
        <p>[ZH 待译 · 卡片一正文] Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.</p>
      </article>
      <article>
        <h2>[ZH 待译 · 卡片二标题]</h2>
        <p>[ZH 待译 · 卡片二正文] Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      </article>
      <article>
        <h2>[ZH 待译 · 卡片三标题]</h2>
        <p>[ZH 待译 · 卡片三正文] Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.</p>
      </article>
      <article>
        <h2>[ZH 待译 · 卡片四标题]</h2>
        <p>[ZH 待译 · 卡片四正文] Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      </article>
    </div>
  </section>

  <section class="landing-compare" aria-labelledby="compare-title">
    <div class="landing-section-heading">
      <p>[ZH 待译 · 对比栏目标签]</p>
      <h2 id="compare-title">[ZH 待译 · 对比栏目标题]</h2>
    </div>
    <div class="compare-card">
      <div class="compare-card-header" aria-hidden="true">
        <span>[ZH 待译 · 左列标题]</span>
        <span></span>
        <span>[ZH 待译 · 右列标题]</span>
      </div>
      <div class="compare-row" data-topic="[ZH 待译]">
        <div class="compare-cell compare-before">
          <span>[ZH 待译 · 维度一]</span>
          <p>[ZH 待译 · 维度一 · 之前]</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>[ZH 待译 · 维度一]</span>
          <p>[ZH 待译 · 维度一 · 之后]</p>
        </div>
      </div>
      <div class="compare-row" data-topic="[ZH 待译]">
        <div class="compare-cell compare-before">
          <span>[ZH 待译 · 维度二]</span>
          <p>[ZH 待译 · 维度二 · 之前]</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>[ZH 待译 · 维度二]</span>
          <p>[ZH 待译 · 维度二 · 之后]</p>
        </div>
      </div>
      <div class="compare-row" data-topic="[ZH 待译]">
        <div class="compare-cell compare-before">
          <span>[ZH 待译 · 维度三]</span>
          <p>[ZH 待译 · 维度三 · 之前]</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>[ZH 待译 · 维度三]</span>
          <p>[ZH 待译 · 维度三 · 之后]</p>
        </div>
      </div>
    </div>
    <p class="compare-note">
      [ZH 待译 · 对比脚注] Lorem ipsum dolor sit amet, consectetur adipiscing elit.
    </p>
  </section>

  <section class="landing-start" aria-labelledby="start-title">
    <div class="landing-section-heading">
      <p>[ZH 待译 · 开始栏目标签]</p>
      <h2 id="start-title">[ZH 待译 · 开始栏目标题]</h2>
    </div>
    <p class="landing-start-frame">
      [ZH 待译 · 开始说明] Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.
    </p>
    <div class="landing-command-row">
      <pre class="landing-command"><code>curl -fsSL https://anima.meetquinn.ai/install.sh | sh</code></pre>
      <button
        class="landing-copy-command"
        type="button"
        aria-label="Copy install command"
        data-command="curl -fsSL https://anima.meetquinn.ai/install.sh | sh"
      >[ZH 待译 · 复制]</button>
    </div>
    <nav class="landing-links" aria-label="Get started links">
      <a href="/guide/quickstart">[ZH 待译 · 阅读快速上手]</a>
    </nav>
  </section>
</main>
