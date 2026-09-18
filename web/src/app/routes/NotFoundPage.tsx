import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div className="measure">
        <h1 className="font-display text-2xl font-semibold text-ink">This page doesn&rsquo;t exist</h1>
        <p className="mt-3 text-[15px] text-muted">The link may be out of date.</p>
        <Link to="/chat" className="mt-6 inline-block font-medium text-ink underline underline-offset-2">
          Go to chat
        </Link>
      </div>
    </div>
  );
}
