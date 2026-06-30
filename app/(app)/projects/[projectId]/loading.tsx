export default function ProjectWorkspaceLoading() {
  return (
    <div className="grid gap-4">
      <div className="ui-skeleton h-44" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="ui-skeleton h-24" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.55fr)]">
        <div className="ui-skeleton h-128" />
        <div className="ui-skeleton h-128" />
      </div>
    </div>
  );
}
