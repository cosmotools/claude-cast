/** What a hidden value is replaced with. */
export const HIDDEN = '(hidden by cast)';
/** Names that hold credentials: in headers, JSON fields and URL or form parameters. */
const SECRET_NAME = /token|secret|passw|api[-_]?key|session|cookie|authorization|^code$/i;
/** Authorization headers keep their scheme ("Bearer"), which tells how the site signs in. */
const AUTH_HEADER = /^(proxy-)?authorization$/i;
/**
 * Hides credentials in what Playwright MCP prints about network requests: header values
 * ("authorization: Bearer …", "cookie: …"), string fields of JSON bodies ("access_token": "…") and
 * URL or form parameters (access_token=…). The names stay, so Claude still sees how a request is made.
 */
export function hideCredentials(text) {
    return text
        .replace(/^(\s*)([A-Za-z0-9!#$%&'*+.^_`|~-]+): (.*)$/gm, (line, indent, name, value) => {
        if (!SECRET_NAME.test(name))
            return line;
        const scheme = AUTH_HEADER.test(name) ? /^([A-Za-z-]+) \S/.exec(value)?.[1] : undefined;
        return `${indent}${name}: ${scheme ? `${scheme} ` : ''}${HIDDEN}`;
    })
        .replace(/("([^"\\]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (field, head, name) => SECRET_NAME.test(name) ? `${head}"${HIDDEN}"` : field)
        .replace(/(^|[?&\s])([^=&?\s]+)=([^&\s]*)/gm, (param, start, name) => SECRET_NAME.test(name) ? `${start}${name}=${HIDDEN}` : param);
}
