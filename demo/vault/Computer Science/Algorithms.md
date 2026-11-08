An algorithm is a finite sequence of steps that solves a problem. How fast it grows is described with [[Big O]].

Binary search in Python:

```python
def binary_search(items, target):
    lo, hi = 0, len(items) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
```

Precondition for binary search >> The list must be sorted

Time complexity of binary search >> $O(\log n)$
