from PIL import Image, ImageDraw
from pathlib import Path

dest = Path(__file__).resolve().parents[1] / 'src' / 'renderer' / 'assets'
im = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((12, 12, 500, 500), radius=114, fill='#0e141b', outline='#273440', width=5)
d.arc((104, 104, 399, 405), 48, 326, fill='#dcf596', width=33)
d.line((390, 263, 271, 263), fill='#dcf596', width=33)
d.line((384, 254, 384, 365), fill='#dcf596', width=30)
d.line((334, 84, 290, 168), fill='#819aac', width=11)
d.line((391, 86, 347, 171), fill='#d58b78', width=11)
im.save(dest / 'icon.png')
im.save(dest / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
