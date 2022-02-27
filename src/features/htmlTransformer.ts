export function transformHtml(html: string): string {
  return journalWrap(enrichHTML(html))
}

function journalWrap(html: string): string {
  return `
<body class="vtt game system-swade">
<div class="app window-app sheet journal-sheet" data-appid="54">

  <section class="window-content">
  <form class="editable" autocomplete="off">

  <div class="editor"><div class="editor-content-foundry" data-edit="content">${html}</div>

</form></section>
</div></body>`
}

function enrichHTML(content: string) {
  const documentTypes = ['Actor', 'Cards', 'Item', 'Scene', 'JournalEntry', 'Macro', 'RollTable', 'PlaylistSound', 'Compendium'];
  const documentRgx = new RegExp(`@(${documentTypes.join("|")})\\[([^\\]]+)\\](?:{([^}]+)})?`, 'g');
  content = content.replace(documentRgx, `<a class="entity-link content-link" draggable="true" data-type="$1" data-entity="Cards" data-id="mbRg8PVKFb5rCr9Q">
  <i class="fas fa-id-badge"></i> $3</a>`)
  return content;
}
