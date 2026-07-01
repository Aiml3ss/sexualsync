import BrandWordmark from "@/components/BrandWordmark";

export default function SplashScreen() {
  return (
    <div className="surface splash" aria-hidden="true">
      <div className="splash-atmosphere" aria-hidden="true">
        <div className="splash-bloom" />
        <div className="grain" />
      </div>
      <main className="splash-stage">
        <BrandWordmark scale="splash" />
        <div className="splash-pulse" aria-hidden="true">
          <span className="splash-dot" />
          <span className="splash-dot" />
          <span className="splash-dot" />
        </div>
      </main>
    </div>
  );
}
