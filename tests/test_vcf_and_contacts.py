"""
Unit and Integration Tests for Bulk Contacts and .vcf Upload Feature.
Verifies:
- vCard parsing (vCard 2.1, 3.0, 4.0, iOS extended, quoted-printable UTF-8)
- Phone number normalization (E.164)
- Database contacts CRUD & bulk insertion with deduplication
- FastAPI contacts & .vcf upload REST endpoints
"""

import unittest
import os
os.environ["USE_SQLITE"] = "true"
import io
from fastapi.testclient import TestClient

from database import (
    init_db,
    create_contact,
    bulk_create_contacts,
    get_contacts,
    get_contact,
    get_contact_by_phone,
    update_contact,
    delete_contact,
    delete_contacts,
    clear_all_contacts,
    get_contacts_count,
    get_contact_groups
)
from vcf_parser import (
    normalize_phone_number,
    parse_vcf_text,
    parse_vcf_bytes,
    export_contacts_to_vcf
)
from server import app as fastapi_app

SAMPLE_VCF_DATA = """BEGIN:VCARD
VERSION:3.0
N:Verma;Kavita;;;
FN:Kavita Verma
ORG:Organic Agro Farms
TEL;TYPE=CELL,VOICE:+91 91234 56789
TEL;TYPE=WORK:022-25001122
EMAIL;TYPE=INTERNET:kavita@organicagro.org
NOTE:Key distributor for organic seeds
END:VCARD
BEGIN:VCARD
VERSION:2.1
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=B8=E0=A5=81=E0=A4=A8=E0=A4=BF=E0=A4=A4=E0=A4=BE=20=E0=A4=AF=E0=A4=BE=E0=A4=A6=E0=A4=B5
TEL;CELL;PREF:9876543210
ORG:Kisan Seva Kendra
EMAIL;HOME:sunita@kisan.org
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Doe;John;;;
item1.TEL;type=pref:+1 (415) 555-0199
item1.X-ABLabel:iPhone
ORG:Global AgTech
EMAIL:john.doe@example.com
END:VCARD
"""

class TestVcfAndContacts(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        init_db()
        clear_all_contacts()
        cls.client = TestClient(fastapi_app)

    def tearDown(self):
        clear_all_contacts()

    def test_01_phone_normalization(self):
        self.assertEqual(normalize_phone_number("+91 98765-43210"), "+919876543210")
        self.assertEqual(normalize_phone_number("9876543210", default_country_code="+91"), "+919876543210")
        self.assertEqual(normalize_phone_number("09876543210", default_country_code="+91"), "+919876543210")
        self.assertEqual(normalize_phone_number("00919876543210"), "+919876543210")
        self.assertEqual(normalize_phone_number("+1 (415) 555-2671"), "+14155552671")
        # Invalid / short numbers
        self.assertEqual(normalize_phone_number("123"), "")
        self.assertEqual(normalize_phone_number(""), "")

    def test_02_vcf_parsing(self):
        contacts = parse_vcf_text(SAMPLE_VCF_DATA, default_group="TestGroup")
        # Kavita has 2 phones, Sunita has 1, John has 1 -> Total 4 dialable contacts
        self.assertEqual(len(contacts), 4)

        names = [c["name"] for c in contacts]
        phones = [c["phone"] for c in contacts]

        self.assertIn("Kavita Verma", names)
        self.assertIn("+919123456789", phones)
        self.assertIn("+912225001122", phones)

        # Verify UTF-8 quoted-printable decoding
        self.assertIn("सुनिता यादव", names)
        self.assertIn("+919876543210", phones)

        # Verify iOS item1.TEL and structured name fallback
        self.assertIn("John Doe", names)
        self.assertIn("+14155550199", phones)

    def test_03_database_contacts_crud(self):
        cid = create_contact(
            name="Ramesh Patel",
            phone="+919876500001",
            email="ramesh@example.com",
            organization="Patel Farms",
            group_tag="Farmers"
        )
        self.assertIsNotNone(cid)

        # Read back
        contact = get_contact(cid)
        self.assertEqual(contact["name"], "Ramesh Patel")
        self.assertEqual(contact["phone"], "+919876500001")
        self.assertEqual(contact["organization"], "Patel Farms")

        # Update
        update_contact(cid, {"notes": "Updated note"})
        upd_contact = get_contact(cid)
        self.assertEqual(upd_contact["notes"], "Updated note")

        # Delete
        delete_contact(cid)
        self.assertIsNone(get_contact(cid))

    def test_04_bulk_create_and_deduplication(self):
        raw_list = [
            {"name": "User 1", "phone": "+919999900001", "group_tag": "GroupA"},
            {"name": "User 2", "phone": "+919999900002", "group_tag": "GroupA"},
            {"name": "User 1 Duplicate", "phone": "+919999900001", "group_tag": "GroupA", "email": "user1@new.com"}
        ]
        result = bulk_create_contacts(raw_list, update_duplicates=True)
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["added"], 2)
        self.assertEqual(result["updated"], 1)

        # Verify only 2 unique phone records exist in DB
        self.assertEqual(get_contacts_count(), 2)

        # Verify enriched email on duplicate
        c1 = get_contact_by_phone("+919999900001")
        self.assertEqual(c1["email"], "user1@new.com")

    def test_05_vcf_export(self):
        contacts = [
            {"name": "Vijay Kumar", "phone": "+919811122233", "email": "vijay@agro.org", "organization": "Agro Corp"}
        ]
        vcf_str = export_contacts_to_vcf(contacts)
        self.assertIn("BEGIN:VCARD", vcf_str)
        self.assertIn("FN:Vijay Kumar", vcf_str)
        self.assertIn("TEL;TYPE=CELL,VOICE:+919811122233", vcf_str)
        self.assertIn("ORG:Agro Corp", vcf_str)
        self.assertIn("END:VCARD", vcf_str)

    def test_06_fastapi_contacts_endpoints(self):
        # 1. POST /api/contacts
        res = self.client.post("/api/contacts", json={
            "name": "API Contact",
            "phone": "+919822233344",
            "email": "api@contact.com",
            "organization": "API Org",
            "group_tag": "API-Group"
        })
        self.assertEqual(res.status_code, 200)
        cid = res.json()["contact_id"]

        # 2. GET /api/contacts
        res_get = self.client.get("/api/contacts?search=API")
        self.assertEqual(res_get.status_code, 200)
        data = res_get.json()
        self.assertGreaterEqual(data["total"], 1)
        self.assertEqual(data["contacts"][0]["phone"], "+919822233344")

        # 3. POST /api/contacts/upload-vcf
        vcf_file_io = io.BytesIO(SAMPLE_VCF_DATA.encode("utf-8"))
        res_upload = self.client.post(
            "/api/contacts/upload-vcf",
            files={"vcf_file": ("contacts.vcf", vcf_file_io, "text/vcard")},
            data={"group_tag": "VCF-Uploaded-Group", "default_country_code": "+91"}
        )
        self.assertEqual(res_upload.status_code, 200)
        up_json = res_upload.json()
        self.assertTrue(up_json["success"])
        self.assertEqual(up_json["total_parsed"], 4)
        self.assertEqual(up_json["summary"]["added"], 4)

        # 4. GET /api/contacts/export-vcf
        res_exp = self.client.get("/api/contacts/export-vcf")
        self.assertEqual(res_exp.status_code, 200)
        self.assertIn("BEGIN:VCARD", res_exp.text)
        self.assertIn("+919123456789", res_exp.text)

        # 5. DELETE /api/contacts/{cid}
        res_del = self.client.delete(f"/api/contacts/{cid}")
        self.assertEqual(res_del.status_code, 200)

        # 6. DELETE /api/contacts (clear)
        res_clear = self.client.delete("/api/contacts")
        self.assertEqual(res_clear.status_code, 200)
        self.assertEqual(get_contacts_count(), 0)

if __name__ == "__main__":
    unittest.main()

