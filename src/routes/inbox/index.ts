import { OpenAPIHono } from "@hono/zod-openapi";
import type { CloudflareBindings } from "../../types/bindings";
import { ackHandler, ackRoute } from "./ack";
import { deleteAllHandler, deleteAllRoute } from "./deleteAll";
import { sealHandler, sealRoute } from "./seal";
import { sendHandler, sendRoute } from "./send";
import { syncHandler, syncRoute } from "./sync";

export const inboxRouter = new OpenAPIHono<{ Bindings: CloudflareBindings }>()
  .openapi(sealRoute, sealHandler)
  .openapi(sendRoute, sendHandler)
  .openapi(syncRoute, syncHandler)
  .openapi(ackRoute, ackHandler)
  .openapi(deleteAllRoute, deleteAllHandler);
