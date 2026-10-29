export interface AdminEnv {
  org: string;
  productName: string;
  apiBase: string;
  pageBase: string;
  onView: (view: string) => void;
}

export interface AdminController {
  route: () => void;
  show: (view: string) => void;
}

export function startAdmin(host: HTMLElement, env: AdminEnv): AdminController;
