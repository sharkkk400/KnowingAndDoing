"""Decode SZSE's public XLSX report using only the Python standard library."""
import sys, io, json, zipfile, re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

def parse(payload, codes):
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 120_000_000:
            raise ValueError('报表解压后过大')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(n.itertext()) for n in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        header = None
        result = []
        with archive.open('xl/worksheets/sheet1.xml') as sheet:
            for _, row in ET.iterparse(sheet, events=('end',)):
                if row.tag != '{'+ns['m']+'}row':
                    continue
                cells = {}
                for c in row:
                    col = re.sub(r'\d', '', c.attrib.get('r', ''))
                    v = c.find('m:v', ns)
                    value = v.text if v is not None else ''
                    if c.attrib.get('t') == 's':
                        value = strings[int(value)]
                    elif c.attrib.get('t') == 'inlineStr':
                        value = ''.join(c.itertext())
                    cells[col] = value
                if header is None:
                    if '日期' in cells.values() and '基金代码' in cells.values():
                        header = {v: k for k, v in cells.items()}
                        if '基金规模(份)' not in header:
                            raise ValueError('份额列或单位变化')
                else:
                    code = cells.get(header['基金代码'], '').strip().removesuffix('.0').zfill(6)
                    if code in codes:
                        date = cells.get(header['日期'], '')
                        if re.fullmatch(r'\d+(\.0)?', date):
                            date = (datetime(1899, 12, 30)+timedelta(days=float(date))).strftime('%Y-%m-%d')
                        date = date.replace('/', '-')[:10]
                        shares = cells.get(header['基金规模(份)'], '').replace(',', '')
                        result.append({'symbol': 'sz'+code, 'date': date, 'shares': float(shares)})
                row.clear()
        if header is None:
            raise ValueError('深交所报表表头异常')
        return result

if __name__ == '__main__':
    print(json.dumps(parse(sys.stdin.buffer.read(), set(sys.argv[1:]))))
