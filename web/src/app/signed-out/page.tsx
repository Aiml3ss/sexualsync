import Link from "next/link";

export default function SignedOutPage() {
  return (
    <main className="surface signed-out min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <section className="signed-out-panel" aria-labelledby="signed-out-title">
        <span className="signed-out-mark" aria-hidden="true">ss</span>
        <p className="eyebrow">Signed out</p>
        <h1 id="signed-out-title">This device is clear.</h1>
        <p>
          Your Sexualsync session was closed here. Open the app again when you are ready to come back to your space.
        </p>
        <div className="signed-out-actions">
          <Link className="btn-primary pressable" href="/signin">
            Sign back in
          </Link>
          <Link className="btn-ghost pressable" href="/">
            Back to welcome
          </Link>
        </div>
      </section>
    </main>
  );
}
