import Link from "next/link";
import { notFound } from "next/navigation";

import { requireViewer } from "@/lib/auth-server";
import { getSpaceDetail } from "@/lib/services/spaces";
import { PageHeader } from "@/components/app/page-header";
import { SpaceDetailView } from "@/components/spaces/space-detail-view";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ spaceId: string }> };

export default async function SpaceDetailPage({ params }: Props) {
  const viewer = await requireViewer();
  const { spaceId } = await params;
  const detail = await getSpaceDetail(viewer, spaceId);
  if (!detail) notFound();

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow={detail.kind === "company" ? "Company space" : "Personal space"}
        title={detail.name}
        description={
          detail.kind === "company"
            ? detail.leadName
              ? `Led by ${detail.leadName} · members get access to every project here.`
              : "No lead assigned."
            : "Private to you."
        }
        action={
          <Link href="/spaces" className="ui-button-secondary">
            All spaces
          </Link>
        }
      />
      <SpaceDetailView detail={detail} />
    </div>
  );
}
