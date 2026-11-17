// Local images that the reply actually presents. Code examples and remote URLs
// stay text; reading the selected paths belongs to the existing workspace reader.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g
const IMAGE = /!\[([^\]\n]*)\]\((<[^<>\n]*>|[^\s()<>]+)(?:\s+"[^"\n]*")?\)/g

export function replyImages(text) {
  const images = []
  const body = String(text ?? '').split(CODE).map((part, index) => index % 2 === 1 ? part : part.replace(IMAGE, (whole, label, destination) => {
    const path = destination.startsWith('<') ? destination.slice(1, -1) : destination
    if (/^[\\/]{2}/.test(path) || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/^file:\/\//i.test(path))) return whole
    images.push({ path, label: label || 'Image' })
    return label
  })).join('')
  return { text: body, images }
}
