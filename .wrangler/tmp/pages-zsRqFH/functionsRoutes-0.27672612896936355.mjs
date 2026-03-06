import { onRequestGet as __api_health_js_onRequestGet } from "E:\\Project\\Personal\\ai-search-tool\\functions\\api\\health.js"
import { onRequestPost as __api_run_js_onRequestPost } from "E:\\Project\\Personal\\ai-search-tool\\functions\\api\\run.js"

export const routes = [
    {
      routePath: "/api/health",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_health_js_onRequestGet],
    },
  {
      routePath: "/api/run",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_run_js_onRequestPost],
    },
  ]