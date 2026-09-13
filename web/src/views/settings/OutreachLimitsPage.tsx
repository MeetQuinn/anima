import DoNotContactSection from '@/components/DoNotContactSection';

/**
 * Outreach limits — the Policies page. Holds the do-not-contact list that
 * used to sit inside the Server panel. The section still carries its own
 * masthead and horizontal padding from that life; the negative margin lines
 * its rule up with the page column until the section is redrawn for this
 * page (tracked separately — content is deliberately untouched here).
 */
export default function OutreachLimitsPage() {
  return (
    <div className="-mx-4 md:-mx-6">
      <DoNotContactSection />
    </div>
  );
}
