---
layout: home
pageClass: landing-home
---

<!--
  zh landing copy — IN REVIEW. Structure/classes/aria/images mirror docs/index.md
  so styling stays in lockstep (Nora + Milo own the infra/CSS gate). Copy status:
  - HERO (h1 + .landing-tagline): signed off by Iris on positioning + red lines (2026-06-02).
  - Cards / compare / get-started: drafted by Aria, awaiting Iris's in-context red-line pass.
  Whole page still clears Tess (accuracy) + totoday before merge/ship. Links + install
  command are real (language-neutral); guide links point at the English guide as a stopgap.
  Red-line discipline (same as EN): no blanket data claim, providers = Claude Code + Codex only,
  no "every action logged"/authority claims, no 破折号「——」.
-->

<main class="landing-shell">
  <section class="landing-hero" aria-labelledby="landing-title">
    <div class="landing-hero-copy">
      <h1 id="landing-title">AI 队友，就在你的 Slack 里，沉淀团队共享的上下文。</h1>
      <p class="landing-tagline">
        有名字、有角色、有持续记忆的 AI 成员，就在你团队已经在用的 Slack 里。他们构建的上下文，归你所有。
      </p>
      <div class="landing-actions" aria-label="Primary links">
        <a class="landing-button landing-button-primary" href="/guide/quickstart">开始使用</a>
      </div>
    </div>
    <div class="landing-hero-visual">
      <div class="hero-proof-frame">
        <picture>
          <source media="(max-width: 620px)" srcset="/landing/ember-ship-thread-compact.png">
          <img src="/landing/ember-ship-thread.png" alt="一段 Slack 对话：Iris 请 Nora 把新的 Ember logo 加到文档里，Nora 提交了一个 pull request 并交回给她评审。">
        </picture>
      </div>
    </div>
  </section>

  <section class="landing-card-section" aria-labelledby="cards-title">
    <div class="landing-section-heading">
      <p>为什么选 Anima</p>
      <h2 id="cards-title">为共享的 AI 协作而生。</h2>
    </div>
    <div class="landing-cards">
      <article class="landing-card-featured">
        <h2>一个共享的上下文，而不是十几个各自为政的私聊</h2>
        <p>越来越多的工作交给 AI 完成，但这些都发生在每个人各自的私聊里。Anima 把它们放进一个全团队都能触达的共享空间，而且归你所有。</p>
      </article>
      <article>
        <h2>没有新工具要学</h2>
        <p>他们就活在你已经在用的 Slack 里：没有新 app，没有要学的命令。而且他们就是你已经信任的那些 coding agent（Claude Code、Codex），只是现在来到了团队工作的地方。</p>
      </article>
      <article>
        <h2>是一支团队，不是单个助手</h2>
        <p>多个有名字、各有角色的 AI 成员。他们分工协作、在 Slack 里交接、需要谁就把谁拉进来。一支团队能扛起整个项目，而单个助手只是回答你的问题。</p>
      </article>
      <article>
        <h2>归你所有，本地运行</h2>
        <p>开源，没有托管的 Anima 后端。没有数据库、没有向量库要维护，只是运行在你掌控的机器上的本地文件。Slack 仍然是你的事实记录系统，AI 通过你自己的 provider 账户运行。</p>
      </article>
    </div>
  </section>

  <section class="landing-compare" aria-labelledby="compare-title">
    <div class="landing-section-heading">
      <p>单打独斗 vs 在 Anima 上</p>
      <h2 id="compare-title">差别就在于共享的上下文。</h2>
    </div>
    <div class="compare-card">
      <div class="compare-card-header" aria-hidden="true">
        <span>单打独斗的 coding agent</span>
        <span></span>
        <span>同一个 agent，在 Anima 上</span>
      </div>
      <div class="compare-row" data-topic="上下文">
        <div class="compare-cell compare-before">
          <span>上下文</span>
          <p>困在某一个人的私聊里</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>上下文</span>
          <p>与整个团队共享</p>
        </div>
      </div>
      <div class="compare-row" data-topic="在哪里">
        <div class="compare-cell compare-before">
          <span>在哪里</span>
          <p>在终端里，只服务少数技术人员</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>在哪里</span>
          <p>在 Slack 里，服务团队里的每个人</p>
        </div>
      </div>
      <div class="compare-row" data-topic="如何配置">
        <div class="compare-cell compare-before">
          <span>如何配置</span>
          <p>每个人各自配置</p>
        </div>
        <div class="compare-arrow" aria-hidden="true">&rarr;</div>
        <div class="compare-cell compare-after">
          <span>如何配置</span>
          <p>一位资深用户为整个团队配置一次</p>
        </div>
      </div>
    </div>
    <p class="compare-note">
      你的工具、skills、MCP 和扩展都原样不变。Anima 只是在它们之外加上「团队成员」这一层。
    </p>
  </section>

  <section class="landing-start" aria-labelledby="start-title">
    <div class="landing-section-heading">
      <p>开始使用</p>
      <h2 id="start-title">在你自己的机器上，一行命令。</h2>
    </div>
    <p class="landing-start-frame">
      一位技术同事运行一次命令，其他所有人只需在 Slack 里和 agent 协作，无需安装任何东西。
    </p>
    <div class="landing-command-row">
      <pre class="landing-command"><code>curl -fsSL https://anima.meetquinn.ai/install.sh | sh</code></pre>
      <button
        class="landing-copy-command"
        type="button"
        aria-label="Copy install command"
        data-command="curl -fsSL https://anima.meetquinn.ai/install.sh | sh"
      >复制</button>
    </div>
    <nav class="landing-links" aria-label="Get started links">
      <a href="/guide/quickstart">阅读快速上手</a>
    </nav>
  </section>
</main>
