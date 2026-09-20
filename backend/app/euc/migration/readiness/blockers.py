"""Migration blocker catalogue grounded in Stage 2.2 and 2.3 evidence."""

import hashlib

from ..models import MigrationBlocker


def _id(kind: str, identity: str) -> str:
    return f"MBL_{hashlib.sha256(f'{kind}:{identity}'.encode()).hexdigest()[:20].upper()}"


class BlockerEngine:
    def evaluate(self, features: dict, units: list) -> list[MigrationBlocker]:
        candidates = features["stage23_features"].get("candidates", {})
        results: list[MigrationBlocker] = []
        for item in candidates.get("unresolved_external", []):
            source = str(item.get("source_euc_reference") or "unknown workbook")
            results.append(self._blocker("UNRESOLVED_EXTERNAL_DEPENDENCY", "INTEGRATION", "CRITICAL", source,
                "Dependent calculations cannot be migrated or validated.", "Onboard and map the external workbook before dependent domains.", "L", item))
        for item in candidates.get("local_paths", []):
            source = str(item.get("path") or "local path")
            results.append(self._blocker("LOCAL_FILE_SYSTEM_DEPENDENCY", "INTEGRATION", "HIGH", source,
                "The dependency will fail outside the originating machine.", "Move the source to a governed connector or service contract.", "M", item))
        for item in candidates.get("cycles", []):
            results.append(self._blocker("CRITICAL_CIRCULAR_DEPENDENCY", "CALCULATION", "HIGH", item.get("cycle_id", "cycle"),
                "Calculation ordering and parity cannot be guaranteed.", "Break the cycle or define an explicit iterative calculation contract.", "L", item))
        dynamic = candidates.get("dynamic", [])
        if dynamic:
            results.append(self._blocker("DYNAMIC_REFERENCE_ARCHITECTURE", "CALCULATION", "HIGH", f"{len(dynamic)} dynamic references",
                "Static target mapping is incomplete.", "Replace INDIRECT/OFFSET patterns with explicit typed references.", "L", {"count": len(dynamic)}))
        if features["stage23_features"].get("automation", {}).get("vba_present"):
            vba = next((item for item in features["objects"] if item["object_type"] == "VBA_PROJECT"), {})
            results.append(self._blocker("UNSUPPORTED_VBA_AUTOMATION", "AUTOMATION", "HIGH", vba.get("object_name") or "VBA project",
                "Automation requires capability-level reengineering and cannot be translated blindly.", "Inventory user, file, email, COM, and database side effects; rebuild them as services.", "XL", vba))
        for connection in features["connections"]:
            if connection.get("credential_present"):
                results.append(self._blocker("EMBEDDED_CONNECTION_CREDENTIAL", "SECURITY", "CRITICAL", connection.get("connection_name") or "connection",
                    "Secrets cannot be migrated from workbook metadata.", "Rotate the credential and configure a managed secret-backed connector.", "M", connection))
        if features["intelligence"].get("control_strength", 0) < 40:
            results.append(self._blocker("LOW_CONTROL_COVERAGE", "CONTROL", "HIGH", "Workbook control environment",
                "Migration may remove or weaken undocumented controls.", "Agree the target control matrix before implementation begins.", "L", features["intelligence"]))
        unsupported = [unit for unit in units if unit.mode == "UNSUPPORTED"]
        for unit in unsupported[:100]:
            results.append(self._blocker("UNSUPPORTED_COMPONENT", "COMPONENT", "HIGH", unit.source_name,
                "No deterministic target mapping is available.", "Retire, replace, or approve a manual reengineering pattern.", "L", unit.evidence, unit.unit_id))
        unique = {(item.blocker_type, item.affected_component): item for item in results}
        order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        return sorted(unique.values(), key=lambda item: (order[item.severity], item.blocker_type, item.affected_component))

    @staticmethod
    def _blocker(kind, category, severity, component, effect, remediation, effort, evidence, unit_id=None):
        impact = evidence.get("dependency_impact", evidence) if isinstance(evidence, dict) else {}
        return MigrationBlocker(_id(kind, str(component)), kind, category, severity, str(component),
                                effect, remediation, effort, unit_id, impact, evidence)
