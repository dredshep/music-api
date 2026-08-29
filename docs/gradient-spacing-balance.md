# Fixed-length Gradient spacing objective

For a fixed-length route, track slots should be distributed across the musical journey rather than clustered in one region. A 10-track route has 9 transitions, so the natural route-distance step is about 11.1% per transition. This is a soft target rather than an exact grid, but a single ~30-35% jump is a spacing defect even if the route is otherwise valid.

Spacing repair therefore evaluates both normalized route-distance distribution and absolute edge cost. A repair is not accepted merely because it increases total route cost elsewhere and makes the same bad edge occupy a smaller percentage of the denominator.

Interior recordings produced by the planner are replaceable. Exact segment endpoints remain protected; incidental recordings that happen to sit on a dominant cliff are not automatically treated as user constraints.
