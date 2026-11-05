export const WEB_BUILD_HEADER = "x-qm-web-build";
export const WEB_BUILD_META = "qm-web-build";

export function stampWebBuild(html: string, build: string | undefined): string {
  return build ? html.replace("</head>", `<meta name="${WEB_BUILD_META}" content="${build}" />\n</head>`) : html;
}
