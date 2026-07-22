const SKILLS_HOSTS = new Set([
  "partner.skills.google",
  "partner.cloudskillsboost.google",
  "www.cloudskillsboost.google",
  "cloudskillsboost.google"
]);

export function isSkillsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SKILLS_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeCourseLinks(links) {
  const unique = new Map();
  for (const link of links) {
    if (!isSkillsUrl(link.href)) continue;
    try {
      const url = new URL(link.href);
      url.hash = "";
      const href = url.toString();
      
      // Extract course template ID from pathname (e.g., /course_templates/1722)
      const pathParts = url.pathname.split("/").filter(Boolean);
      const templateIndex = pathParts.indexOf("course_templates");
      let key = href;
      if (templateIndex !== -1 && pathParts[templateIndex + 1]) {
        key = pathParts[templateIndex + 1]; // Use template ID as unique key
      }
      
      if (!unique.has(key)) {
        unique.set(key, { href, label: link.label?.trim() || href });
      }
    } catch {
      // Fallback if URL parsing fails
      if (!unique.has(link.href)) {
        unique.set(link.href, { href: link.href, label: link.label?.trim() || link.href });
      }
    }
  }
  return [...unique.values()];
}
