import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireViewer } from "@/lib/auth-server";
import {
  addSpaceMember,
  createSpace,
  deleteSpace,
  removeSpaceMember,
  renameSpace,
  setSpaceLead,
} from "@/lib/services/spaces";

// One op-dispatch endpoint for the Spaces management UI. Each op delegates to a
// service that does its own authz (admin to create; lead/admin to manage), so
// the route just parses, dispatches, and surfaces the service's error message.
const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().trim().min(1).max(80) }),
  z.object({
    op: z.literal("rename"),
    spaceId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ op: z.literal("delete"), spaceId: z.string().min(1) }),
  z.object({
    op: z.literal("addMember"),
    spaceId: z.string().min(1),
    email: z.email().transform((v) => v.toLowerCase()),
  }),
  z.object({
    op: z.literal("removeMember"),
    spaceId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    op: z.literal("setLead"),
    spaceId: z.string().min(1),
    userId: z.string().min(1),
  }),
]);

export async function POST(request: Request) {
  const viewer = await requireViewer();

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    let spaceId: string | undefined;
    switch (body.op) {
      case "create": {
        const r = await createSpace(viewer, { name: body.name });
        spaceId = r.spaceId;
        break;
      }
      case "rename":
        await renameSpace(viewer, { spaceId: body.spaceId, name: body.name });
        break;
      case "delete":
        await deleteSpace(viewer, { spaceId: body.spaceId });
        break;
      case "addMember":
        await addSpaceMember(viewer, {
          spaceId: body.spaceId,
          email: body.email,
        });
        break;
      case "removeMember":
        await removeSpaceMember(viewer, {
          spaceId: body.spaceId,
          userId: body.userId,
        });
        break;
      case "setLead":
        await setSpaceLead(viewer, {
          spaceId: body.spaceId,
          userId: body.userId,
        });
        break;
    }
    revalidatePath("/spaces");
    revalidatePath("/admin/spaces");
    if (body.op !== "create") revalidatePath(`/spaces/${body.spaceId}`);
    return Response.json({ ok: true, spaceId });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update spaces." },
      { status: 400 },
    );
  }
}
