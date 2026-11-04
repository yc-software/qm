export const APP_CONNECTION_APPS: Readonly<
  Record<string, { skill: string; routes: ReadonlyArray<readonly [host: string, pathPrefix?: string]> }>
> = {
  gmail: { skill: "google-workspace", routes: [["gmail.googleapis.com"]] },
  googlecalendar: { skill: "google-workspace", routes: [["www.googleapis.com", "/calendar/"]] },
  googletasks: { skill: "google-workspace", routes: [["www.googleapis.com", "/tasks/"]] },
  googledrive: {
    skill: "google-drive-sheets",
    routes: [
      ["www.googleapis.com", "/drive/"],
      ["www.googleapis.com", "/upload/drive/"],
    ],
  },
  googledocs: { skill: "google-drive-sheets", routes: [["docs.googleapis.com"]] },
  googlesheets: { skill: "google-drive-sheets", routes: [["sheets.googleapis.com"]] },
  googleslides: { skill: "google-drive-sheets", routes: [["slides.googleapis.com"]] },
  dropbox: { skill: "dropbox", routes: [["api.dropboxapi.com"], ["content.dropboxapi.com"]] },
  linear: { skill: "linear", routes: [["api.linear.app"]] },
  zoom: { skill: "zoom", routes: [["api.zoom.us"]] },
};

export const APP_CONNECTION_SKILLS: ReadonlySet<string> = new Set(
  Object.values(APP_CONNECTION_APPS).map((app) => app.skill),
);
