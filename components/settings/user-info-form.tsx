"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, CircleNotch, Trash, UploadSimple } from "@phosphor-icons/react";

import { Avatar } from "@/components/ui/avatar";
import { authClient } from "@/lib/auth-client";
import { toast } from "@/lib/toast";

type Props = {
  name: string;
  email: string;
  image: string | null;
};

// Self-service profile editing. Everything here is editable except the email
// (the account identity / login). Name + avatar go through Better Auth's
// updateUser; the avatar file is uploaded to R2 first to get a served URL.
export function UserInfoForm({ name: initialName, email, image: initialImage }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const [uploading, setUploading] = useState(false);
  const [isPending, startTransition] = useTransition();

  const dirty = name.trim() !== initialName || image !== initialImage;
  const canSave = dirty && name.trim().length > 0 && !uploading && !isPending;

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch("/api/uploads/image", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Upload failed");
      }
      setImage(data.url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Upload failed", "danger");
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await authClient.updateUser({
        name: name.trim(),
        image: image ?? "",
      });
      if (result.error) {
        toast(result.error.message ?? "Could not save changes.", "danger");
        return;
      }
      toast("Profile updated", "success");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) handleSubmit();
      }}
      className="grid gap-5"
    >
      {/* Avatar */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar
          name={name}
          email={email}
          image={image}
          px={64}
          className="size-16 rounded-md text-[18px]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || isPending}
            className="ui-button-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <CircleNotch className="size-4 animate-spin" />
            ) : (
              <UploadSimple className="size-4" />
            )}
            {uploading ? "Uploading…" : "Change photo"}
          </button>
          {image ? (
            <button
              type="button"
              onClick={() => setImage(null)}
              disabled={uploading || isPending}
              className="ui-button-ghost text-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
              title="Remove photo"
            >
              <Trash className="size-4" />
              Remove
            </button>
          ) : null}
        </div>
      </div>

      {/* Name */}
      <label className="grid gap-2">
        <span className="text-sm font-medium text-foreground">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          className="ui-input"
          placeholder="Your name"
        />
      </label>

      {/* Email (read-only) */}
      <label className="grid gap-2">
        <span className="text-sm font-medium text-foreground">Email</span>
        <input
          value={email}
          readOnly
          disabled
          className="ui-input cursor-not-allowed opacity-70"
        />
        <span className="text-[12px] text-muted">
          Your email is your sign-in identity and can&apos;t be changed here.
        </span>
      </label>

      <div>
        <button
          type="submit"
          disabled={!canSave}
          className="ui-button-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? (
            <CircleNotch className="size-4 animate-spin" />
          ) : (
            <CheckCircle className="size-4" />
          )}
          Save changes
        </button>
      </div>
    </form>
  );
}
