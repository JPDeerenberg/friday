<script lang="ts">
  interface Props {
    content: string;
    html: string | null;
  }
  let { content, html }: Props = $props();

  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (anchor?.href) {
      // Let DOMPurify-sanitized hrefs through. Tauri opener or external browser.
      // Inline markdown links are https/mailto/tel only per sanitize.ts
    }
  }

  async function copyCode(e: MouseEvent) {
    const btn = e.currentTarget as HTMLButtonElement;
    const pre = btn.closest('pre');
    const code = pre?.querySelector('code');
    const text = code?.textContent ?? pre?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = 'Gekopieerd!';
      setTimeout(() => (btn.textContent = orig), 1500);
    } catch {}
  }
</script>

{#if html !== null && html !== ''}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="markdown-content text-[13px] leading-relaxed" onclick={handleClick}>
    {@html html}
  </div>
{:else}
  <!-- Fallback while marked chunk loads: plain text preserves whitespace -->
  <p class="whitespace-pre-wrap text-[13px]">{content}</p>
{/if}

<style>
  .markdown-content :global(h1) {
    font-size: 15px;
    font-weight: 900;
    color: white;
    line-height: 1.3;
    margin: 10px 0 6px;
    text-transform: uppercase;
    letter-spacing: -0.02em;
    border-left: 3px solid var(--color-primary-500);
    padding-left: 8px;
  }
  .markdown-content :global(h2) {
    font-size: 13px;
    font-weight: 900;
    color: var(--color-primary-400);
    line-height: 1.3;
    margin: 10px 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .markdown-content :global(h3) {
    font-size: 13px;
    font-weight: 800;
    color: #e2e8f0;
    margin: 8px 0 4px;
  }
  .markdown-content :global(p) {
    color: #e2e8f0;
    margin: 6px 0;
    line-height: 1.6;
  }
  .markdown-content :global(a) {
    color: #38bdf8;
    text-decoration: underline;
    text-underline-offset: 2px;
    word-break: break-word;
  }
  .markdown-content :global(strong), .markdown-content :global(b) {
    color: white;
    font-weight: 800;
  }
  .markdown-content :global(em), .markdown-content :global(i) {
    font-style: italic;
    color: #cbd5e1;
  }
  .markdown-content :global(ul) {
    margin: 6px 0 8px 4px;
    padding: 0;
    list-style: none;
  }
  .markdown-content :global(ol) {
    margin: 6px 0 8px 18px;
    list-style: decimal;
    color: #94a3b8;
  }
  .markdown-content :global(ul li) {
    position: relative;
    padding-left: 16px;
    margin: 3px 0;
    color: #cbd5e1;
  }
  .markdown-content :global(ul li::before) {
    content: '•';
    position: absolute;
    left: 0;
    color: var(--color-primary-500);
    font-weight: 900;
  }
  .markdown-content :global(ol li) {
    margin: 3px 0;
    padding-left: 4px;
    color: #cbd5e1;
  }
  .markdown-content :global(li) :global(p) {
    margin: 0;
    display: inline;
  }
  .markdown-content :global(blockquote) {
    border-left: 2px solid color-mix(in oklch, var(--color-primary-500), transparent 60%);
    padding-left: 10px;
    margin: 8px 0;
    color: #94a3b8;
    font-style: italic;
  }
  .markdown-content :global(code) {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.06);
    padding: 1px 5px;
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #e2e8f0;
    word-break: break-word;
  }
  .markdown-content :global(pre) {
    position: relative;
    background: rgba(0,0,0,0.35);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px;
    padding: 12px;
    margin: 8px 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .markdown-content :global(pre code) {
    background: transparent;
    border: none;
    padding: 0;
    border-radius: 0;
    color: #e2e8f0;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
    word-break: normal;
  }
  .markdown-content :global(hr) {
    border: none;
    border-top: 1px solid rgba(255,255,255,0.08);
    margin: 10px 0;
  }
  .markdown-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 12px;
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .markdown-content :global(th) {
    text-align: left;
    font-weight: 800;
    color: white;
    border-bottom: 1px solid rgba(255,255,255,0.12);
    padding: 6px 8px;
    white-space: nowrap;
  }
  .markdown-content :global(td) {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    color: #cbd5e1;
  }
  .markdown-content :global(tr:last-child td) {
    border-bottom: none;
  }
  .markdown-content :global(img) {
    max-width: 100%;
    border-radius: 10px;
    margin: 6px 0;
  }
  .markdown-content :global(del), .markdown-content :global(s) {
    opacity: 0.7;
    text-decoration: line-through;
  }
</style>
