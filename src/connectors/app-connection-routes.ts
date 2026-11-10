export const APP_CONNECTION_ROUTES: Readonly<
  Record<string, ReadonlyArray<readonly [host: string, pathPrefix?: string]>>
> = {
  gmail: [["gmail.googleapis.com"]],
  googlecalendar: [["www.googleapis.com", "/calendar/"]],
  googletasks: [["www.googleapis.com", "/tasks/"]],
  googledrive: [
    ["www.googleapis.com", "/drive/"],
    ["www.googleapis.com", "/upload/drive/"],
  ],
  googledocs: [["docs.googleapis.com"]],
  googlesheets: [["sheets.googleapis.com"]],
  googleslides: [["slides.googleapis.com"]],
  dropbox: [["api.dropboxapi.com"], ["content.dropboxapi.com"]],
  linear: [["api.linear.app"]],
  zoom: [["api.zoom.us"]],
};
