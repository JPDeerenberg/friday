<script lang="ts">
  import { onMount } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { createEditor, EditorContent } from 'svelte-tiptap';
  import StarterKit from '@tiptap/starter-kit';
  import Underline from '@tiptap/extension-underline';
  import Link from '@tiptap/extension-link';
  import Placeholder from '@tiptap/extension-placeholder';

  interface Props {
    content?: string;
    placeholder?: string;
    onUpdate?: (html: string) => void;
  }

  let { content = '', placeholder = 'Typ hier je tekst...', onUpdate }: Props = $props();

  let editor = $state() as Readable<any>;

  onMount(() => {
    editor = createEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        Underline,
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: 'text-primary-400 underline hover:text-primary-300' },
        }),
        Placeholder.configure({
          placeholder,
        }),
      ],
      content: content || '<p></p>',
      onUpdate: ({ editor: ed }: any) => {
        const html = ed.getHTML();
        if (onUpdate) onUpdate(html);
      },
    });
  });

  function toggleBold() {
    if (!$editor) return;
    $editor.chain().focus().toggleBold().run();
  }

  function toggleItalic() {
    if (!$editor) return;
    $editor.chain().focus().toggleItalic().run();
  }

  function toggleUnderline() {
    if (!$editor) return;
    $editor.chain().focus().toggleUnderline().run();
  }

  function toggleStrike() {
    if (!$editor) return;
    $editor.chain().focus().toggleStrike().run();
  }

  function toggleBulletList() {
    if (!$editor) return;
    $editor.chain().focus().toggleBulletList().run();
  }

  function toggleOrderedList() {
    if (!$editor) return;
    $editor.chain().focus().toggleOrderedList().run();
  }

  function toggleHeading(level: 1 | 2 | 3) {
    if (!$editor) return;
    $editor.chain().focus().toggleHeading({ level }).run();
  }

  function setLink() {
    if (!$editor) return;
    const previousUrl = $editor.getAttributes('link').href;
    const url = window.prompt('Link URL:', previousUrl || 'https://');
    if (url === null) return;
    if (url === '') {
      $editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    $editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  function isActive(type: string, attrs?: any): boolean {
    if (!$editor) return false;
    return $editor.isActive(type, attrs);
  }

  const toolbarButtons = [
    { group: [
      { label: 'B', action: toggleBold, active: () => isActive('bold'), title: 'Vet (Ctrl+B)' },
      { label: 'I', action: toggleItalic, active: () => isActive('italic'), title: 'Cursief (Ctrl+I)' },
      { label: 'U', action: toggleUnderline, active: () => isActive('underline'), title: 'Onderstreept (Ctrl+U)' },
      { label: 'S', action: toggleStrike, active: () => isActive('strike'), title: 'Doorstreept' },
    ]},
    { group: [
      { label: 'H1', action: () => toggleHeading(1), active: () => isActive('heading', { level: 1 }), title: 'Kop 1' },
      { label: 'H2', action: () => toggleHeading(2), active: () => isActive('heading', { level: 2 }), title: 'Kop 2' },
      { label: 'H3', action: () => toggleHeading(3), active: () => isActive('heading', { level: 3 }), title: 'Kop 3' },
    ]},
    { group: [
      {
        label: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="16" y1="6" y2="6"/><line x1="8" x2="16" y1="12" y2="12"/><line x1="8" x2="16" y1="18" y2="18"/><line x1="3" x2="3" y1="6" y2="6" stroke="currentColor" stroke-width="3"/></svg>`,
        action: toggleBulletList,
        active: () => isActive('bulletList'),
        title: 'Lijst'
      },
      {
        label: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><line x1="3" x2="3" y1="6" y2="6" stroke="currentColor" stroke-width="3"/><line x1="3" x2="3" y1="12" y2="12" stroke="currentColor" stroke-width="3"/><line x1="3" x2="3" y1="18" y2="18" stroke="currentColor" stroke-width="3"/></svg>`,
        action: toggleOrderedList,
        active: () => isActive('orderedList'),
        title: 'Genummerde lijst'
      },
      {
        label: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
        action: setLink,
        active: () => isActive('link'),
        title: 'Link'
      },
    ]},
  ];
</script>

<div class="rich-editor-wrapper rounded-2xl border border-surface-700/50 focus-within:border-primary-500/40 transition-colors bg-surface-900/40 overflow-hidden">
  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-0.5 px-2 py-2 border-b border-surface-700/30 bg-surface-900/60 overflow-x-auto no-scrollbar">
    {#each toolbarButtons as section}
      <div class="flex items-center gap-0.5 px-1 border-r border-surface-700/30 last:border-r-0">
        {#each section.group as btn}
          <button
            onclick={btn.action}
            title={btn.title}
            class="px-2 py-1.5 rounded-lg text-xs font-bold transition-all
                   {btn.active()
                     ? 'bg-primary-500/20 text-primary-400 shadow-sm'
                     : 'text-gray-500 hover:text-gray-300 hover:bg-surface-800/60'}"
          >
            {#if btn.label.includes('<svg')}
              {@html btn.label}
            {:else}
              {btn.label}
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <!-- Editor Content -->
  <div class="px-4 py-3 min-h-[120px] text-sm text-gray-200 leading-relaxed prose-custom">
    {#if $editor}
      <EditorContent editor={$editor} />
    {:else}
      <div class="flex items-center gap-2 text-gray-600">
        <div class="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin"></div>
        <span class="text-xs">Editor laden...</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

  .rich-editor-wrapper :global(.ProseMirror) {
    outline: none;
    min-height: 100px;
  }
  .rich-editor-wrapper :global(.ProseMirror p) {
    margin: 0.25rem 0;
    line-height: 1.6;
  }
  .rich-editor-wrapper :global(.ProseMirror h1) {
    font-size: 1.25rem;
    font-weight: 800;
    color: white;
    margin: 0.75rem 0 0.25rem;
    letter-spacing: -0.02em;
  }
  .rich-editor-wrapper :global(.ProseMirror h2) {
    font-size: 1.05rem;
    font-weight: 700;
    color: #d8b4fe;
    margin: 0.5rem 0 0.25rem;
    letter-spacing: -0.01em;
  }
  .rich-editor-wrapper :global(.ProseMirror h3) {
    font-size: 0.95rem;
    font-weight: 700;
    color: #cbd5e1;
    margin: 0.5rem 0 0.25rem;
  }
  .rich-editor-wrapper :global(.ProseMirror ul),
  .rich-editor-wrapper :global(.ProseMirror ol) {
    padding-left: 1.25rem;
    margin: 0.25rem 0;
  }
  .rich-editor-wrapper :global(.ProseMirror li) {
    margin: 0.15rem 0;
    color: #94a3b8;
  }
  .rich-editor-wrapper :global(.ProseMirror strong) {
    color: white;
    font-weight: 800;
  }
  .rich-editor-wrapper :global(.ProseMirror em) {
    color: #cbd5e1;
  }
  .rich-editor-wrapper :global(.ProseMirror s) {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .rich-editor-wrapper :global(.ProseMirror a) {
    color: #60a5fa;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .rich-editor-wrapper :global(.ProseMirror p.is-editor-empty:first-child::before) {
    color: #4b5563;
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }
  .rich-editor-wrapper :global(.ProseMirror ul) {
    list-style-type: disc;
  }
  .rich-editor-wrapper :global(.ProseMirror ol) {
    list-style-type: decimal;
  }
</style>