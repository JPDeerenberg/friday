import DOMPurify from 'dompurify';

// Explicit allow-list for HTML originating from other Magister users
// (message bodies, assignment/activity/studiewijzer descriptions).
// No style, no on* event attributes, no script/iframe/object/embed/forms.
const ALLOWED_TAGS = [
  '#text',
  'a',
  'b',
  'br',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const ALLOWED_ATTR = ['href', 'src', 'alt', 'target', 'rel'];

// Only these URI schemes may be used in href/src; anything else (javascript:,
// data:, vbscript:, file:, etc.) is stripped by DOMPurify and then double
// checked here.
const ALLOWED_URI_SCHEMES = /^(https?|mailto|tel):/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const href = node.getAttribute('href');
  if (href && /^[a-z][a-z0-9+.-]*:/i.test(href) && !ALLOWED_URI_SCHEMES.test(href)) {
    node.removeAttribute('href');
  }
  const src = node.getAttribute('src');
  if (src && /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(https?:|data:image\/)/i.test(src)) {
    node.removeAttribute('src');
  }
});

export function sanitizeHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
