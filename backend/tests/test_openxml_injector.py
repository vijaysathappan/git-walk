import tempfile
import unittest
import zipfile
from pathlib import Path

from openpyxl import load_workbook

from app.openxml_injector import inject_taskpane_manifest


class OpenXmlInjectorTests(unittest.TestCase):
    def test_embeds_table_id_in_addin_settings(self):
        backend_dir = Path(__file__).resolve().parent.parent
        source = backend_dir / "test_upload.xlsx"

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "configured.xlsx"
            inject_taskpane_manifest(
                str(source),
                str(output),
                table_id="QUEUE_BOARD_TEST1234",
            )

            with zipfile.ZipFile(output) as workbook:
                settings_xml = workbook.read(
                    "xl/webextensions/webextension1.xml"
                ).decode("utf-8")
                workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")

            self.assertIn('name="tableId"', settings_xml)
            self.assertIn('value="QUEUE_BOARD_TEST1234"', settings_xml)
            self.assertIn('name="_EXCEL_SQLITE_SYNC_TABLE_ID"', workbook_xml)

            configured_workbook = load_workbook(output, read_only=True)
            embedded_name = configured_workbook.defined_names[
                "_EXCEL_SQLITE_SYNC_TABLE_ID"
            ]
            self.assertEqual('"QUEUE_BOARD_TEST1234"', embedded_name.attr_text)
            configured_workbook.close()


if __name__ == "__main__":
    unittest.main()
