import { OpenAPIHono } from "@hono/zod-openapi";
import type { CloudflareBindings } from "../../types/bindings";
import { availabilityHandler, availabilityRoute } from "./availability";
import { eraseHandler, eraseRoute } from "./erase";
import { directoryHandler, directoryRoute } from "./directory";
import { historyHandler, historyRoute } from "./history";
import { recoverHandler, recoverRoute } from "./recover";
import { registerHandler, registerRoute } from "./register";
import { releaseHandler, releaseRoute } from "./release";

export const nip05Router = new OpenAPIHono<{ Bindings: CloudflareBindings }>()
  .openapi(directoryRoute, directoryHandler)
  .openapi(availabilityRoute, availabilityHandler)
  .openapi(registerRoute, registerHandler)
  .openapi(releaseRoute, releaseHandler)
  .openapi(eraseRoute, eraseHandler)
  .openapi(recoverRoute, recoverHandler)
  .openapi(historyRoute, historyHandler);
