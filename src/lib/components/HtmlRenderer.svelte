<script lang="ts">
  interface Props {
    html: string;
  }
  let { html }: Props = $props();

  // Simple "parser" that handles common Magister tags by mapping them to styled divs
  // This is better than raw {@html} because we can control the layout and styling in Svelte
  function parseHtml(raw: string) {
    if (!raw) return [];
    
    // This is a naive parser. For complex HTML, a real DOMParser or library would be better.
    // However, Magister HTML is usually quite simple.
    // We'll normalize some common patterns.
    let cleaned = raw
      .replace(/<o:p>&nbsp;<\/o:p>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();

    // To make it a "parser", we'll split into block elements
    // We'll use a simple regex to find tags
    const blocks: { tag: string; content: string }[] = [];
    
    // Note: This is an extremely simplified parser for demonstration
    // In a real app, I'd use DOMParser().parseFromString(html, 'text/html')
    // but here I'll try to follow the "parser" request literally.
    
    // Check if we are in a browser environment to use DOMParser
    if (typeof window !== 'undefined' && typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(cleaned, 'text/html');
        return Array.from(doc.body.childNodes).map(node => {
            const el = node as HTMLElement;
            return {
                tag: el.tagName?.toLowerCase() || 'text',
                content: el.innerHTML || el.textContent || '',
                raw: el.outerHTML || el.textContent || ''
            };
        });
    }

    return [{ tag: 'div', content: cleaned, raw: cleaned }];
  }

  let nodes = $derived(parseHtml(html));
</script>

<div class="magister-content space-y-2">
  {#each nodes as node}
    {#if node.tag === 'h1'}
      <h1 class="text-lg font-black text-white leading-tight mt-4 mb-2 italic tracking-tighter uppercase border-l-4 border-primary-500 pl-3">
        {@html node.content}
      </h1>
    {:else if node.tag === 'h2'}
      <h2 class="text-base font-black text-primary-400 leading-tight mt-3 mb-1 uppercase tracking-widest">
        {@html node.content}
      </h2>
    {:else if node.tag === 'h3'}
      <h3 class="text-sm font-black text-gray-200 mt-2 mb-1">
        {@html node.content}
      </h3>
    {:else if node.tag === 'p'}
      <p class="text-[13px] text-gray-400 leading-relaxed mb-3">
        {@html node.content}
      </p>
    {:else if node.tag === 'ul'}
      <ul class="space-y-1.5 mb-4 ml-1">
        {@html node.content}
      </ul>
    {:else if node.tag === 'li'}
      <li class="flex gap-3 text-[13px] text-gray-400">
        <span class="text-primary-500 mt-1">•</span>
        <span>{@html node.content}</span>
      </li>
    {:else if node.tag === 'br'}
      <div class="h-1"></div>
    {:else if node.tag === 'text'}
      {#if node.content.trim()}
        <span class="text-[13px] text-gray-400 leading-relaxed">{@html node.content}</span>
      {/if}
    {:else}
      <div class="text-[13px] text-gray-400 leading-relaxed">
        {@html node.raw}
      </div>
    {/if}
  {/each}
</div>

<style>
  .magister-content :global(b), .magister-content :global(strong) {
    color: white;
    font-weight: 800;
  }
  .magister-content :global(i), .magister-content :global(em) {
    font-style: italic;
    color: #cbd5e1;
  }
  .magister-content :global(a) {
    color: #38bdf8;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .magister-content :global(li) {
    display: list-item;
    list-style-type: disc;
    margin-left: 1.25rem;
    color: #94a3b8;
  }
  .magister-content :global(ul) {
    margin-bottom: 1rem;
  }
</style>
